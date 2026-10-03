import {it,expect} from 'vitest';
import {validateImage,MAX_IMAGE_BYTES} from '../src/images';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
it('accepts raster bytes and rejects MIME spoofing, SVG, invalid base64 and oversized pastes',()=>{
 expect(validateImage({name:'image.png',mimeType:'image/png',data:png})).toBeGreaterThan(0);
 for(const image of [{mimeType:'image/jpeg',data:png},{mimeType:'image/svg+xml',data:Buffer.from('<svg/>').toString('base64')},{mimeType:'image/png',data:'not base64'},{mimeType:'image/png',data:Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')}])expect(()=>validateImage({name:'test',...image})).toThrow();
});
