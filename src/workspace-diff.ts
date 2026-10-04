import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath,readlink,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {TextDecoder} from 'node:util';
import type {Entry} from './shared';
import {nextId} from './state';
import {turnDiffText,type TurnDiff,type TurnFileDiff} from './turn-diff';

export const DIFF_LIMITS = {files:5000,fileBytes:1024*1024,snapshotBytes:16*1024*1024,resultBytes:4*1024*1024,commandMs:10000,collectionMs:15000};
const scope = '工作区本轮开始到结束的净变化；不含 Git 忽略文件。并发的手工或其他会话修改也可能计入；不是文件回滚点。';
interface FileState {signature:string;text?:string;mode:number;omitted?:string}
interface Capture {files:Map<string,FileState>;warnings:string[]}
const inside = (root:string,path:string) => {const name=relative(root,path);return name!=='..'&&!name.startsWith('..'+sep)&&!isAbsolute(name);};

/** Read-only git commands. Never stage, reset, create commits, or run external diff/textconv. */
function git(cwd:string,args:string[],maxBuffer=2*1024*1024,allowDiff=false):Promise<string> {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  return new Promise((resolve,reject)=>execFile('git',['--no-pager','--no-optional-locks','-c','core.fsmonitor=false','-c','core.autocrlf=false',...args],
    {cwd,env,encoding:'utf8',timeout:DIFF_LIMITS.commandMs,maxBuffer,windowsHide:true},(error,stdout)=>{
      if(error&&!(allowDiff&&(error as {code?:unknown}).code===1))reject(new Error('Git 修改采集失败或超过时间/大小限制。'));
      else resolve(stdout);
    }));
}

async function readState(root:string,name:string,budget:{bytes:number}):Promise<FileState|undefined> {
  const file=resolve(root,name);
  if(!inside(root,file))throw new Error('文件路径超出工作区');
  try {
    // Do not follow directory symlinks into secrets or unrelated workspaces.
    if(!inside(root,await realpath(dirname(file))))throw new Error('目录链接超出工作区');
    const info=await lstat(file),mode=info.mode&0o177777;
    const signature=`metadata:${mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if(info.isSymbolicLink()) {
      const text=await readlink(file);
      return {signature:`link:${text}`,text,mode};
    }
    if(!info.isFile())return {signature,mode,omitted:'非普通文件（目录或子模块）'};
    if(info.size>DIFF_LIMITS.fileBytes||budget.bytes+info.size>DIFF_LIMITS.snapshotBytes)
      return {signature,mode,omitted:'文件或快照超过采集上限'};
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let bytes:Buffer;
    try {
      const opened=await handle.stat();
      if(!opened.isFile()||opened.ino!==info.ino||opened.dev!==info.dev)throw new Error('采集时文件发生替换');
      const actual=await realpath(process.platform==='linux'?`/proc/self/fd/${handle.fd}`:file);
      if(!inside(root,actual))throw new Error('打开的文件超出工作区');
      const buffer=Buffer.alloc(Math.min(info.size+1,DIFF_LIMITS.fileBytes+1,DIFF_LIMITS.snapshotBytes-budget.bytes+1));
      let length=0;
      while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
      const final=await handle.stat();
      if(length!==info.size||final.mtimeMs!==info.mtimeMs||final.size!==info.size)throw new Error('采集期间文件发生变化');
      if(length>DIFF_LIMITS.fileBytes||budget.bytes+length>DIFF_LIMITS.snapshotBytes)throw new Error('读取时文件超过采集上限');
      bytes=buffer.subarray(0,length);budget.bytes+=length;
    } finally {await handle.close();}
    const hash=createHash('sha256').update(bytes).digest('hex');
    let text:string;
    try {if(bytes.includes(0))throw new Error('binary');text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
    catch {return {signature:hash,mode,omitted:'二进制或非 UTF-8 文件，不展示内容'};}
    return {signature:hash,mode,text};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')return;
    throw error;
  }
}

async function capture(root:string,known:Iterable<string>=[]):Promise<Capture> {
  // Relative paths from ls-files are relative to cwd, so a nested workspace stays scoped to that directory.
  const names=new Set((await git(root,['ls-files','-z','--cached','--others','--exclude-standard','--','.'])).split('\0').filter(Boolean));
  for(const name of known)names.add(name); // An ignore-rule change must not masquerade as deletion.
  if(names.size>DIFF_LIMITS.files)throw new Error(`工作区超过 ${DIFF_LIMITS.files} 个文件，未采集完整差异。`);
  const result:Capture={files:new Map(),warnings:[]},budget={bytes:0},deadline=Date.now()+DIFF_LIMITS.collectionMs;
  for(const name of [...names].sort()) {
    if(Date.now()>deadline)throw new Error('工作区文件采集超过时间限制。');
    try {const state=await readState(root,name,budget);if(state)result.files.set(name,state);}
    catch {result.files.set(name,{signature:'unreadable',mode:0,omitted:'文件无法安全读取'});}
  }
  const omitted=[...result.files.values()].filter(file=>file.omitted).length;
  if(omitted)result.warnings.push(`${omitted} 个文件未采集文本内容（大小限制、二进制、子模块或读取失败）。`);
  return result;
}

async function compare(before:Capture,after:Capture):Promise<TurnDiff> {
  const warnings=[...new Set([...before.warnings,...after.warnings])];
  const diff:TurnDiff={status:warnings.length?'partial':'complete',files:[],warnings};
  let directory:string|undefined,used=0;
  const deadline=Date.now()+DIFF_LIMITS.collectionMs;
  try {
    for(const name of [...new Set([...before.files.keys(),...after.files.keys()])].sort()) {
      const old=before.files.get(name),current=after.files.get(name);
      if(old&&current&&old.signature===current.signature&&old.mode===current.mode)continue;
      const file:TurnFileDiff={path:name,status:!old?'added':!current?'deleted':'modified',added:0,removed:0,oldMode:old?.mode,newMode:current?.mode};
      if(old?.omitted||current?.omitted)file.omitted=old?.omitted||current?.omitted;
      else if(Date.now()>deadline)file.omitted='本轮补丁计算超过时间限制';
      else {
        const oldText=old?.text||'',newText=current?.text||'';
        if(Buffer.byteLength(oldText)+Buffer.byteLength(newText)+used>DIFF_LIMITS.resultBytes)file.omitted='本轮差异内容超过展示上限';
        else {
          directory??=await mkdtemp(join(tmpdir(),'pi-turn-diff-'));
          await writeFile(join(directory,'before'),oldText,{mode:0o600});
          await writeFile(join(directory,'after'),newText,{mode:0o600});
          try {
            const raw=await git(directory,['diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--unified=3','--','before','after'],2*1024*1024,true);
            const lines=raw.split('\n'),start=lines.findIndex(line=>line.startsWith('@@'));
            const hunks=start<0?[]:lines.slice(start);
            file.added=hunks.filter(line=>line.startsWith('+')).length;
            file.removed=hunks.filter(line=>line.startsWith('-')).length;
            const label=(prefix:string)=>JSON.stringify(prefix+name);
            const headers=[`diff --git ${label('a/')} ${label('b/')}`];
            if(!old&&current)headers.push(`new file mode ${current.mode.toString(8)}`);
            else if(old&&!current)headers.push(`deleted file mode ${old.mode.toString(8)}`);
            else if(old&&current&&old.mode!==current.mode)headers.push(`old mode ${old.mode.toString(8)}`,`new mode ${current.mode.toString(8)}`);
            file.patch=[...headers,`--- ${old?label('a/'):'/dev/null'}`,`+++ ${current?label('b/'):'/dev/null'}`,...hunks].join('\n');
            file.before=oldText;file.after=newText;
            const bytes=Buffer.byteLength(JSON.stringify(file));
            if(used+bytes>DIFF_LIMITS.resultBytes){delete file.before;delete file.after;delete file.patch;file.omitted='本轮差异内容超过展示上限';}
            else used+=bytes;
          } catch {file.omitted='未能生成此文件的差异';}
        }
      }
      if(file.omitted)diff.status='partial';
      diff.files.push(file);
    }
    if(diff.files.some(file=>file.path.endsWith('.gitignore')))diff.warnings.push('本轮忽略规则发生变化；新增文件列表可能包含此前被忽略的文件。');
    return diff;
  } finally {if(directory)await rm(directory,{recursive:true,force:true});}
}

/** One baseline per actual prompt. The caller owns finalization even on cancellation/error. */
export class WorkspaceDiff {
  private constructor(private root:string,private before?:Capture,private error?:string) {}
  static async begin(cwd:string):Promise<WorkspaceDiff> {
    try {
      const root=await realpath(cwd);
      if((await git(root,['rev-parse','--is-inside-work-tree'])).trim()!=='true')throw new Error('not a worktree');
      return new WorkspaceDiff(root,await capture(root));
    } catch(error) {return new WorkspaceDiff(cwd,undefined,`无法建立本轮基线：需要 Git 工作区且文件数量/体积在采集限制内。${error instanceof Error?error.message:''}`);}
  }
  async finish():Promise<Entry> {
    let diff:TurnDiff;
    try {
      if(!this.before)throw new Error(this.error);
      diff=await compare(this.before,await capture(this.root,this.before.files.keys()));
    } catch(error) {diff={status:'unavailable',files:[],warnings:[error instanceof Error?error.message:String(error)]};}
    finally {this.before=undefined;}
    diff.warnings.push(scope);
    return {id:nextId(),role:'diff',text:turnDiffText(diff),diff};
  }
}
