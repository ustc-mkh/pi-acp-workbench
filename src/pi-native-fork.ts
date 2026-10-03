import {nativePrefixHash,nativeForkPoints,NATIVE_FORK_MARKER,type NativeEntry} from './native-branch';
// Loaded only in an isolated RPC worker. It never prompts a model or changes the source session.
interface Context {
  sessionManager:{getBranch():NativeEntry[];getSessionId():string};
  fork(id:string,options:{position:'at'}):Promise<{cancelled:boolean}>;
}
interface Api {
  on(event:'cache_warming_decision',handler:()=>{action:'stop'}):void;
  registerCommand(name:string,command:{description:string;handler:(args:string,ctx:Context)=>Promise<void>}):void;
  appendEntry(type:string,data:unknown):void;
}
export default function(pi:Api) {
  pi.on('cache_warming_decision',()=>({action:'stop'}));
  pi.registerCommand('workbench-native-fork',{
    description:'Internal: fork a verified native history node without summarization',
    handler:async(args,ctx)=>{
      const {entryId,hash}=JSON.parse(args),path=ctx.sessionManager.getBranch();
      const point=nativeForkPoints(path).find(p=>p.entryId===entryId&&p.hash===hash&&p.safe);
      if(!point)throw new Error('原生分支位置已变化或工具调用尚未配对，原会话未修改。');
      const result=await ctx.fork(entryId,{position:'at'});
      if(result.cancelled)throw new Error('原生分支已取消。');
    }
  });
  pi.registerCommand('workbench-native-seal',{
    description:'Internal: verify copied context and mark inherited billing',
    handler:async(args,ctx)=>{
      const {sourceSessionId,hash}=JSON.parse(args);
      if(!sourceSessionId||sourceSessionId===ctx.sessionManager.getSessionId()||nativePrefixHash(ctx.sessionManager.getBranch())!==hash)
        throw new Error('原生分支内容校验失败；未切换 Workbench 会话。请检查 Pi 版本是否支持 fork position=at。');
      // Metadata only: never enters model context. Copied usage must not be charged twice in Workbench.
      pi.appendEntry(NATIVE_FORK_MARKER,{sourceSessionId});
    }
  });
}
