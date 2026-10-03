import {IMAGE_TYPES,MAX_IMAGE_BYTES,MAX_ATTACHMENT_IMAGE_BYTES,type PastedImage} from '../src/images';
import type {UiMessage} from '../src/shared';
import type {HarnessId} from '../src/harness';
export function readPastedImage(file:File):Promise<PastedImage>{
 if(!IMAGE_TYPES.includes(file.type as typeof IMAGE_TYPES[number]))return Promise.reject(new Error('只支持 PNG、JPEG、WebP 和 GIF 图片。'));
 if(file.size>MAX_IMAGE_BYTES)return Promise.reject(new Error('单张图片不能超过 3 MB，请缩小图片后重试。'));
 return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('图片读取失败，请重新粘贴。'));reader.onload=()=>{const result=String(reader.result||'');resolve({name:file.name||'粘贴图片',mimeType:file.type,data:result.slice(result.indexOf(',')+1)});};reader.readAsDataURL(file);});
}
export function installImagePaste(input:HTMLTextAreaElement,session:()=>string|undefined,send:(message:UiMessage)=>void,busy:(value:boolean)=>void,harness:()=>HarnessId|undefined=()=>undefined){
 let pending=0;
 const paste=(event:ClipboardEvent)=>{
  const files=[...event.clipboardData?.items||[]].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);
  if(!files.length)return;event.preventDefault();
  const selected=harness(),scope=selected?{harness:selected}:{};
  const sessionId=session(),text=event.clipboardData?.getData('text/plain');if(text){input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}
  if(files.length>8||files.reduce((n,f)=>n+f.size,0)>MAX_ATTACHMENT_IMAGE_BYTES){send({type:'attachmentError',...scope,sessionId,error:'每条消息最多 8 个附件，图片总大小不能超过 6 MB。'});return;}
  pending++;busy(true);
  void Promise.all(files.map(readPastedImage)).then(images=>send({type:'attachImages',...scope,sessionId,images})).catch(error=>send({type:'attachmentError',...scope,sessionId,error:error.message})).finally(()=>{pending--;busy(pending>0);});
 };
 input.addEventListener('paste',paste);return()=>input.removeEventListener('paste',paste);
}
export function imagePreview(mimeType:string,data:string,name:string):HTMLImageElement|undefined{
 if(!IMAGE_TYPES.includes(mimeType as typeof IMAGE_TYPES[number])||data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))return;
 const image=document.createElement('img');image.className='pasted-image';image.alt=name;image.src=`data:${mimeType};base64,${data}`;image.loading='lazy';return image;
}
