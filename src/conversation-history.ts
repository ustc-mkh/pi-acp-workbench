import type {Memento} from 'vscode';
import type {ChatState,Snapshot} from './shared';
import {SnapshotStore} from './snapshots';
import {SharedHistoryStore} from './shared-history';
import {HistoryPersistence} from './history-persistence';
import {allocateSessionNumber} from './session-numbers';
import {HARNESS_IDS,harnessKey} from './harness';

interface HistoryOptions {
  storage:Memento;
  localDirectory?:string;
  sharedDirectory?:string;
  enabled:()=>boolean;
  current:()=>ChatState;
  changed:()=>void;
  error:(error:unknown)=>void;
  leaseLost:()=>void;
  remote?:{list:()=>Promise<Snapshot[]>;remove:(id:string)=>Promise<unknown>};
}

/** Owns the index, serialized writes, polling and leases; never owns an Agent or the UI. */
export class ConversationHistory {
  items:Snapshot[];
  readonly forgotten=new Set<string>();
  readonly snapshots:SnapshotStore;
  readonly shared?:SharedHistoryStore;
  readonly persistence:HistoryPersistence;
  activeLease?:string;
  ready:Promise<void>=Promise.resolve();
  private poll?:NodeJS.Timeout;
  private disposed=false;
  constructor(private options:HistoryOptions) {
    this.items=options.enabled()?options.storage.get<Snapshot[]>('history',[]):[];
    if(options.sharedDirectory)this.shared=new SharedHistoryStore(options.sharedDirectory,id=>{
      if(this.activeLease===id)options.leaseLost();
    });
    this.snapshots=this.shared||new SnapshotStore(options.localDirectory);
    this.persistence=new HistoryPersistence(this.snapshots,!!this.shared);
  }
  start() {
    if(!this.shared&&!this.options.remote)return;
    this.initialize();
    this.poll=setInterval(()=>{void this.refresh().catch(this.options.error);},5000);
    this.poll.unref();
  }
  initialize() {
    this.ready=this.ready.then(async()=>{
      if(!this.options.enabled()||this.disposed)return;
      const epoch=this.persistence.epoch,items=await this.list();
      if(this.disposed||epoch!==this.persistence.epoch||!this.options.enabled())return;
      this.items=items;this.options.changed();
    }).catch(this.options.error);
    return this.ready;
  }
  private async list() {
    const local=this.shared?await this.shared.list():this.items;
    if(!this.options.remote)return local;
    try{return [...await this.options.remote.list(),...local.filter(s=>s.harness!=='pi')];}
    catch(error){this.options.error(error);return local;}
  }
  async refresh() {
    await this.ready;
    if(this.disposed||!this.options.enabled())return;
    await this.persistence.enqueue(async()=>{
      const epoch=this.persistence.epoch,items=await this.list();
      if(this.disposed||epoch!==this.persistence.epoch||!this.options.enabled())return;
      const state=this.options.current(),id=state.sessionId,previous=this.items.find(s=>s.id===id);
      if(id&&previous&&!items.some(s=>s.id===id))this.forgotten.add(id);
      if(this.shared&&state.readOnly&&id){
        const item=items.find(s=>s.id===id);
        if(item&&item.revision!==previous?.revision){
          const snapshot=await this.snapshots.read(item);
          if(this.options.current()===state&&epoch===this.persistence.epoch)state.entries=snapshot.entries;
        }
      }
      if(this.disposed||epoch!==this.persistence.epoch||!this.options.enabled())return;
      this.items=items;this.options.changed();
    });
  }
  disable(after:()=>Promise<void>) {
    this.persistence.invalidate();this.items=[];
    return this.persistence.enqueue(async()=>{
      if(!this.shared)await this.options.storage.update('history',undefined);
      for(const harness of HARNESS_IDS)await this.options.storage.update(harnessKey('activeSession',harness),null);
      await after();
      // Client opt-out never creates account-wide tombstones.
      if(!this.shared)await this.snapshots.clear();
    });
  }
  save(snapshot:Snapshot) {
    const epoch=this.persistence.epoch;
    return this.persistence.enqueue(async()=>{
      if(epoch!==this.persistence.epoch)return;
      if(!this.shared){
        const numbering={sessions:this.items,nextSessionNumber:this.options.storage.get<number>('nextSessionNumber',1)};
        snapshot.sessionNumber??=allocateSessionNumber(numbering,snapshot);
        await this.options.storage.update('nextSessionNumber',numbering.nextSessionNumber);
      }
      const index=await this.persistence.write(snapshot,epoch,()=>!this.forgotten.has(snapshot.id)&&this.options.enabled());
      if(!index)return;
      const state=this.options.current();if(state.sessionId===index.id)state.sessionNumber=index.sessionNumber;
      const next=[index,...this.items.filter(s=>s.id!==index.id)];
      if(this.shared){
        const items=await this.shared.list();
        if(epoch!==this.persistence.epoch||!this.options.enabled())return;
        this.items=items;
      }else{
        this.items=next.slice(0,20);await this.options.storage.update('history',this.items);
        for(const old of next.slice(20))await this.snapshots.remove(old.id);
      }
      this.options.changed();
    });
  }
  /** UI confirms deletion and detaches caches before invoking this operation. */
  remove(id:string|undefined,after:()=>Promise<void>) {
    const before=this.items.slice(),removed=id?before.filter(s=>s.id===id):before;
    removed.forEach(s=>this.forgotten.add(s.id));
    const active=this.options.current().sessionId;
    if(!id&&active)this.forgotten.add(active);
    this.items=id?this.items.filter(s=>s.id!==id):[];
    return this.persistence.enqueue(async()=>{
      if(!id&&!this.options.remote)await this.snapshots.clear();
      else for(const item of removed){
        if(item.harness==='pi'&&this.options.remote)await this.options.remote.remove(item.id);
        else await this.snapshots.remove(item.id);
      }
      if(!this.shared)await this.options.storage.update('history',this.items.length?this.items:undefined);
      for(const harness of HARNESS_IDS){
        const key=harnessKey('activeSession',harness);
        if(!id||this.options.storage.get(key)===id)await this.options.storage.update(key,null);
      }
      await after();
    });
  }
  releaseLease() {
    const id=this.activeLease;this.activeLease=undefined;
    if(id&&this.shared)void this.persistence.enqueue(()=>this.shared!.release(id)).catch(this.options.error);
  }
  dispose(){this.disposed=true;clearInterval(this.poll);}
}
