// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {SlashCommands} from '../webview/slash-commands';
afterEach(()=>{document.body.replaceChildren();});
function setup(){
 document.body.innerHTML='<footer style="overflow:auto"><textarea id="input"></textarea><div id="commands" hidden></div></footer>';
 const input=document.querySelector('textarea')!,menu=document.getElementById('commands')!,selected=vi.fn();
 const popup=new SlashCommands(input,menu,selected);
 const type=(text:string)=>{input.focus();input.value=text;input.dispatchEvent(new Event('input'));};
 const key=(key:string,extra={})=>{const e=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});input.dispatchEvent(e);return e;};
 return{input,menu,popup,type,key,selected};
}
it('escapes composer clipping and exposes all commands including late announcements',()=>{
 const {popup,menu,type}=setup();type('/');popup.update([],'ready');expect(menu.textContent).toContain('尚未提供');
 popup.update(Array.from({length:20},(_,i)=>({name:`command${i}`,description:'description'})),'ready');
 expect(menu.parentElement).toBe(document.body);expect(menu.querySelectorAll('button')).toHaveLength(20);expect(menu.hidden).toBe(false);
 type('/COMMAND19');expect(menu.querySelectorAll('button')).toHaveLength(1);
});
it('supports keyboard selection without submitting and keeps Escape dismissed during updates',()=>{
 const {popup,menu,input,type,key,selected}=setup();const commands=[{name:'status',description:'Status'},{name:'compact',description:'Compact'}];
 popup.update(commands,'ready');type('/');expect(key('ArrowDown').defaultPrevented).toBe(true);
 expect(input.getAttribute('aria-activedescendant')).toBe('acp-command-1');
 expect(key('Enter').defaultPrevented).toBe(true);expect(input.value).toBe('/compact ');expect(selected).toHaveBeenCalledOnce();expect(menu.hidden).toBe(true);
 type('/');key('Escape');popup.update(commands,'ready');expect(menu.hidden).toBe(true);
 type('/st');expect(key('Tab').defaultPrevented).toBe(true);expect(input.value).toBe('/status ');
});
it('clears commands on disconnect and does not swallow composition or modified Enter',()=>{
 const {popup,menu,type,key}=setup();popup.update([{name:'status',description:'Status'}],'ready');type('/');
 expect(key('Enter',{isComposing:true}).defaultPrevented).toBe(false);expect(key('Enter',{shiftKey:true}).defaultPrevented).toBe(false);
 popup.update([{name:'status',description:'Status'}],'disconnected');expect(menu.querySelectorAll('button')).toHaveLength(0);expect(menu.textContent).toContain('先连接');
 expect(key('Enter').defaultPrevented).toBe(false);
});
it('click inserts a normalized command rather than executing it',()=>{
 const {popup,menu,input,type,selected}=setup();popup.update([{name:'/model',description:'Model'}],'ready');type('/mo');
 menu.querySelector('button')!.click();expect(input.value).toBe('/model ');expect(selected).toHaveBeenCalledOnce();
});
