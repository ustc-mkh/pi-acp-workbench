export const IMAGE_TYPES=['image/png','image/jpeg','image/webp','image/gif'] as const;
export const MAX_IMAGE_BYTES=3*1024*1024;
export const MAX_ATTACHMENT_IMAGE_BYTES=6*1024*1024;
export interface PastedImage {name:string;mimeType:string;data:string}
export function validateImage(image:PastedImage):number {
  if(!image||!IMAGE_TYPES.includes(image.mimeType as typeof IMAGE_TYPES[number])||typeof image.data!=='string'||typeof image.name!=='string')throw new Error('只支持 PNG、JPEG、WebP 和 GIF 图片。');
  if(image.data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4)throw new Error('单张图片不能超过 3 MB，请缩小图片后重试。');
  if(!image.data.length||image.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))throw new Error('图片数据无效，请重新粘贴。');
  const b=Buffer.from(image.data,'base64');
  const valid=image.mimeType==='image/png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):image.mimeType==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:image.mimeType==='image/gif'?/^GIF8[79]a$/.test(b.subarray(0,6).toString()):b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';
  if(!valid||b.toString('base64')!==image.data)throw new Error('图片格式与内容不匹配，请重新粘贴。');
  return b.length;
}
