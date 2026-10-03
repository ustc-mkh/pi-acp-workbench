// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {StatisticsPage} from '../webview/statistics';
import type {Statistics} from '../src/telemetry';
it('switches model/day/session views, filters dates, and submits editable prices',()=>{
 document.body.innerHTML='<main></main>';HTMLElement.prototype.scrollIntoView=()=>{};
 const root=document.querySelector('main')!,send=vi.fn(),page=new StatisticsPage(root,send,()=>{});
 const data:Statistics={available:true,titles:{s:'数学任务'},prices:{'p/m':{input:2,output:10,cacheRead:.2,cacheWrite:2.5}},records:[{id:'1',sessionId:'s',model:'p/m',timestamp:new Date(2026,9,3,12).getTime(),kind:'inference',input:1000,cacheRead:1000,cacheWrite:0,output:200}]};
 page.update(data);expect(root.textContent).toContain('50.0%');expect(root.querySelector('tbody')?.textContent).toContain('p/m');
 const click=(label:string)=>([...root.querySelectorAll('button')].find(b=>b.textContent===label)!).click();
 click('按天');expect(root.querySelector('tbody')?.textContent).toContain('2026-10-03');
 click('按会话');expect(root.querySelector('tbody')?.textContent).toContain('数学任务');
 const from=root.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!;from.value='2026-10-04';from.dispatchEvent(new Event('change'));expect(root.textContent).toContain('暂无用量');
 click('全部日期');click('按模型');(root.querySelector('.stats-model-link') as HTMLElement).click();
 const field=root.querySelector<HTMLInputElement>('[aria-label="非缓存输入价格"]')!;expect(field.value).toBe('2');field.value='3';click('保存价格');expect(send).toHaveBeenLastCalledWith({type:'setPrice',model:'p/m',price:{input:3,output:10,cacheRead:.2,cacheWrite:2.5}});
 click('恢复默认');expect(send).toHaveBeenLastCalledWith({type:'setPrice',model:'p/m'});
});
