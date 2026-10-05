import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
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
  async write(snapshot: Snapshot): Promise<Snapshot> {
    return this.transaction(async index => {
      if (this.lost.has(snapshot.id) || !this.leases.has(snapshot.id)) throw new Error('未持有共享会话锁，请重新连接后再保存。');
      const current = index.sessions.find(s => s.id === snapshot.id);
      if (index.deleted.includes(snapshot.id)) throw new Error('此会话已从共享历史删除，不会重新保存。');
      if (current && current.revision !== this.seen.get(snapshot.id)) throw new Error('会话已被另一个窗口更新，请重新连接。');
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
    await this.transaction(async index => {
      const current = index.sessions.find(s => s.id === id);
      index.sessions = index.sessions.filter(s => s.id !== id);
      if (!index.deleted.includes(id)) index.deleted.push(id);
      // Commit tombstones before unlinking: a failed unlink cannot resurrect history.
      await this.commit(index); if(current) await this.raw.remove(this.key(current));
    });
  }
  async clear() {
    await this.transaction(async index => {
      const sessions = index.sessions;
      index.deleted = [...new Set([...index.deleted, ...sessions.map(s => s.id)])]; index.sessions = [];
      await this.commit(index);
      for (const snapshot of sessions) await this.raw.remove(this.key(snapshot));
    });
  }
}
