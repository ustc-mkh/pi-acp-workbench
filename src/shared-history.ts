import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { SnapshotStore, validateSnapshot } from './snapshots';
import { allocateSessionNumber, type SessionNumberIndex } from './session-numbers';
import type { Snapshot } from './shared';

interface Index extends SessionNumberIndex { deleted: string[] }
export class SessionInUseError extends Error {
  constructor() { super('此会话正在另一个窗口中使用，当前仅查看。请在原窗口释放会话或关闭窗口后重新连接。'); }
}

/** Server-account history: atomic index transactions plus exclusive live-session leases. */
export class SharedHistoryStore extends SnapshotStore {
  private seen = new Map<string, string | undefined>();
  private leases = new Map<string, () => Promise<void>>();
  private lost = new Set<string>();
  private raw: SnapshotStore;
  private transactions: Promise<unknown> = Promise.resolve();
  private transactionError?: Error;
  constructor(readonly root: string, private onLeaseLost?: (id:string) => void) {
    super();
    this.raw = new SnapshotStore(join(root, 'conversations'));
  }
  private key(snapshot: Snapshot) {
    if(!snapshot.revision)throw new Error('共享历史缺少版本标识，拒绝读取或覆盖。');
    return `${snapshot.id}:${snapshot.revision}`;
  }
  /** Protocol-v2 delegate: when set, write/remove/clear go over the service
   * socket instead of touching the history directory (claim/release stay
   * local — the file lease still marks this client as the live holder). */
  remote?: { write(snapshot: Snapshot): Promise<Snapshot>; remove(id?: string): Promise<void> };
  private async initialize() { await mkdir(this.root, {recursive:true, mode:0o700}); }
  private async index(): Promise<Index> {
    try {
      const data = JSON.parse(await readFile(join(this.root, 'index.json'), 'utf8')) as Index;
      if (!Array.isArray(data.sessions) || !Array.isArray(data.deleted)) throw new Error('共享历史索引无效，请从备份恢复。');
      return {sessions:data.sessions,deleted:data.deleted,nextSessionNumber:data.nextSessionNumber};
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {sessions:[],deleted:[]}; throw error; }
  }
  private transaction<T>(operation: (index: Index) => Promise<T>): Promise<T> {
    const result = this.transactions.catch(() => {}).then(() => this.runTransaction(operation));
    this.transactions = result.then(()=>{},()=>{});
    return result;
  }
  private async runTransaction<T>(operation: (index: Index) => Promise<T>): Promise<T> {
    await this.initialize();
    let compromised: Error | undefined;
    this.transactionError = undefined;
    const release = await lock(this.root, {realpath:false, stale:30000, update:10000, retries:{retries:20,minTimeout:50,maxTimeout:500,randomize:true}, onCompromised:error => { compromised = error; this.transactionError = error; }});
    try {
      const index = await this.index();
      const result = await operation(index);
      if (compromised) throw compromised;
      return result;
    } finally { if (!compromised) await release(); }
  }
  private async commit(index: Index) {
    const file = join(this.root, 'index.json'), temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(index), {mode:0o600});
      if (this.transactionError) throw this.transactionError;
      await rename(temp, file);
    } finally { await rm(temp, {force:true}); }
  }
  async list(): Promise<Snapshot[]> {
    // index.json is committed by atomic rename. Readers see a complete committed
    // version without waiting behind transcript I/O or cross-process writer locks.
    return (await this.index()).sessions.sort((a,b) => b.updated-a.updated);
  }
  async claim(id: string) {
    if (this.leases.has(id)) { if(this.lost.has(id)) throw new Error('共享会话锁已失效，请重新连接。'); return; }
    await this.initialize();
    const key = join(this.root, 'session-' + createHash('sha256').update(id).digest('hex'));
    try {
      const release = await lock(key, {realpath:false, stale:30000, update:10000, retries:0, onCompromised:() => { this.lost.add(id); this.onLeaseLost?.(id); }});
      this.lost.delete(id); this.leases.set(id, release);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new SessionInUseError();
      throw error;
    }
  }
  async release(id: string) {
    const release = this.leases.get(id);
    this.leases.delete(id);this.seen.delete(id);
    const lost = this.lost.delete(id);
    if (release && !lost) await release();
  }
  async releaseAll() { await Promise.all([...this.leases.keys()].map(id => this.release(id))); }
  async read(snapshot: Snapshot) {
    return this.transaction(async index => {
      const current = index.sessions.find(s => s.id === snapshot.id);
      if (!current) {
        if (!snapshot.stored && !index.deleted.includes(snapshot.id)) return validateSnapshot(structuredClone(snapshot));
        throw new Error('共享会话已被删除，请刷新历史列表。');
      }
      const data = await this.raw.read(current, this.key(current));
      if(this.leases.has(data.id))this.seen.set(data.id, data.revision);
      return {...data, sessionNumber:current.sessionNumber};
    });
  }
  /** Freshness probe for a lease this store does not hold: the session lock
   * directory exists and its heartbeat mtime is younger than the stale
   * threshold (30 s, matching the claim lock options). */
  private async externalLease(id: string) {
    if (this.leases.has(id)) return false;
    try {
      const s = await stat(join(this.root, 'session-' + createHash('sha256').update(id).digest('hex') + '.lock'));
      return Date.now() - s.mtimeMs < 30000;
    } catch { return false; }
  }
  /** Socket-delegated write (service protocol `historyWrite`): the caller may
   * hold its own fresh lease; an unheld session is claimed just for the write.
   * A lease already held by this store itself means a live local runtime — the
   * service refuses those before calling here. */
  async writeDelegated(snapshot: Snapshot): Promise<Snapshot> {
    if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id) throw new Error('无效参数：snapshot');
    if (this.leases.has(snapshot.id)) return this.persist(snapshot, false);
    let claimed = false;
    if (!(await this.externalLease(snapshot.id))) {
      try { await this.claim(snapshot.id); claimed = true; }
      catch (error) {
        if (!(error instanceof SessionInUseError) || !(await this.externalLease(snapshot.id))) throw error;
      }
    }
    // Delegated writes always check the caller-supplied base revision, even
    // when we hold a brief claim (the local `seen` map only tracks this
    // store's own reads under its own leases).
    try { return await this.persist(snapshot, true); }
    finally { if (claimed) await this.release(snapshot.id); }
  }
  async write(snapshot: Snapshot): Promise<Snapshot> {
    if (this.remote) {
      const saved = await this.remote.write({...snapshot, revision:this.seen.get(snapshot.id)});
      this.seen.set(saved.id, saved.revision);
      return saved;
    }
    return this.persist(snapshot, false);
  }
  private persist(snapshot: Snapshot, external: boolean): Promise<Snapshot> {
    return this.transaction(async index => {
      if (this.lost.has(snapshot.id) || (!external && !this.leases.has(snapshot.id))) throw new Error('未持有共享会话锁，请重新连接后再保存。');
      const current = index.sessions.find(s => s.id === snapshot.id);
      if (index.deleted.includes(snapshot.id)) throw new Error('此会话已从共享历史删除，不会重新保存。');
      // External (delegated) writes carry the caller's base revision in the
      // snapshot itself; local writes use the revision this store last saw.
      if (current && current.revision !== (external ? snapshot.revision : this.seen.get(snapshot.id))) throw new Error('会话已被另一个窗口更新，请重新连接。');
      const version = {...snapshot, sessionNumber:allocateSessionNumber(index,snapshot), revision:randomUUID()};
      const saved = await this.raw.write(version, this.key(version));
      index.sessions = [saved, ...index.sessions.filter(s => s.id !== snapshot.id)];
      await this.commit(index);
      this.seen.set(saved.id, saved.revision);
      if(current) await this.raw.remove(this.key(current));
      return saved;
    });
  }
  async remove(id: string) {
    if (this.remote) return this.remote.remove(id);
    await this.transaction(async index => {
      const current = index.sessions.find(s => s.id === id);
      index.sessions = index.sessions.filter(s => s.id !== id);
      if (!index.deleted.includes(id)) index.deleted.push(id);
      // Commit tombstones before unlinking: a failed unlink cannot resurrect history.
      await this.commit(index); if(current) await this.raw.remove(this.key(current));
    });
  }
  async clear() {
    if (this.remote) return this.remote.remove(undefined);
    await this.transaction(async index => {
      const sessions = index.sessions;
      index.deleted = [...new Set([...index.deleted, ...sessions.map(s => s.id)])]; index.sessions = [];
      await this.commit(index);
      for (const snapshot of sessions) await this.raw.remove(this.key(snapshot));
    });
  }
}
