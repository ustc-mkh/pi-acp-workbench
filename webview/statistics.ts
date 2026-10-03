import type { Statistics } from '../src/telemetry';
import { groupUsage, dayKey } from '../src/telemetry';
import type { UiMessage } from '../src/shared';
const text=(tag:string,value:string,className?:string)=>{const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el;};
const number=(n:number)=>n.toLocaleString(undefined,{maximumFractionDigits:0});
const money=(n:number)=>'$'+n.toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4});
export class StatisticsPage {
  private data?:Statistics;
  private by:'model'|'day'|'session'='model';
  private from:HTMLInputElement;private until:HTMLInputElement;private table:HTMLElement;private totals:HTMLElement;private note:HTMLElement;
  constructor(private root:HTMLElement,private send:(m:UiMessage)=>void,back:()=>void,private openPrices:(model?:string)=>void) {
    root.className='statistics-page';
    const heading=text('div','','stats-heading'), title=text('h2','用量统计'), close=text('button','返回对话') as HTMLButtonElement;close.type='button';close.onclick=back;
    const refresh=text('button','刷新') as HTMLButtonElement;refresh.type='button';refresh.onclick=()=>send({type:'refreshStatistics'});heading.append(title,refresh,close);root.append(heading);
    root.append(text('p','当前工作区 · 时间按本机时区 · 费用单位 USD','stats-caption'));
    this.note=text('p','','stats-note');root.append(this.note);
    const filters=text('div','','stats-filters');
    this.from=document.createElement('input');this.from.type='date';this.from.setAttribute('aria-label','开始日期');
    this.until=document.createElement('input');this.until.type='date';this.until.setAttribute('aria-label','结束日期');
    const clear=text('button','全部日期') as HTMLButtonElement;clear.type='button';clear.onclick=()=>{this.from.value='';this.until.value='';this.render();};
    for(const input of [this.from,this.until])input.onchange=()=>this.render();
    filters.append(this.from,text('span','至'),this.until,clear);root.append(filters);
    this.totals=text('div','','stats-totals');root.append(this.totals);
    const tabs=text('div','','stats-tabs');tabs.setAttribute('role','tablist');
    for(const [key,label] of [['model','按模型'],['day','按天'],['session','按会话']] as const){const b=text('button',label) as HTMLButtonElement;b.type='button';b.role='tab';b.setAttribute('aria-selected',String(key===this.by));b.onclick=()=>{this.by=key;for(const tab of tabs.children)tab.setAttribute('aria-selected',String(tab===b));this.render();};tabs.append(b);}
    root.append(tabs);this.table=text('div','','stats-table-wrap');root.append(this.table);
    root.append(text('p','总输入 = 非缓存输入 + 缓存读取 + 缓存写入；命中率 = 缓存读取 / 总输入。分支继承的历史不重复计费，摘要重建产生的请求会计入用量。','stats-caption'));
    const settings=text('button','模型价格设置 →','price-settings-link') as HTMLButtonElement;settings.type='button';settings.onclick=()=>this.openPrices();root.append(settings);
  }
  update(data?:Statistics) {this.data=data;this.render();}
  private render(){
    const data=this.data,records=(data?.records||[]).filter(r=>{const day=dayKey(r.timestamp);return (!this.from.value||day>=this.from.value)&&(!this.until.value||day<=this.until.value);});
    this.note.textContent=data?.note||(!data?.available?'当前连接未提供详细用量；连接内置 Pi ACP 适配器后自动记录。已有统计仍保留。':'统计来自 Pi 返回的请求用量，费用按模型价格设置估算。');
    this.totals.replaceChildren();
    const grouped=groupUsage(records.map(r=>({...r,model:'all'})),{all:{input:0,output:0,cacheRead:0,cacheWrite:0}},'model')[0];
    const groups=groupUsage(records,data?.prices||{},'model'), cost=groups.reduce((s,g)=>s+g.cost,0), unknown=groups.reduce((s,g)=>s+g.unpriced,0);
    for(const [label,value] of [['总输入',number(grouped?.totalInput||0)],['输出',number(grouped?.output||0)],['缓存命中',grouped?.cacheRate===undefined?'—':(grouped.cacheRate*100).toFixed(1)+'%'],['估算费用',money(cost)+(unknown?' + 未定价':'')]]){const card=text('div','','stats-card');card.append(text('span',label),text('strong',value));this.totals.append(card);}
    const rows=groupUsage(records,data?.prices||{},this.by);this.table.replaceChildren();
    if(!rows.length){this.table.append(text('p','此范围暂无用量记录。','stats-empty'));return;}
    const table=document.createElement('table'),head=document.createElement('thead'),header=document.createElement('tr');
    for(const label of [this.by==='model'?'模型':this.by==='day'?'日期':'会话','缓存命中','总输入','输出','命中率','估算费用'])header.append(text('th',label));head.append(header);table.append(head);
    const body=document.createElement('tbody');
    for(const row of rows){const tr=document.createElement('tr');const name=this.by==='session'?data?.titles[row.key]||row.key:row.key;
      const first=text('td',name);first.dataset.tooltip=this.by==='session'?`${name}\n${row.key}`:name;tr.append(first);
      for(const value of [number(row.cacheRead),number(row.totalInput),number(row.output),row.cacheRate===undefined?'—':(row.cacheRate*100).toFixed(1)+'%',money(row.cost)+(row.unpriced?' + 未定价':'')])tr.append(text('td',value));
      if(this.by==='model'){first.tabIndex=0;first.className='stats-model-link';const choose=()=>this.openPrices(row.key);first.onclick=choose;first.onkeydown=e=>{if(e.key==='Enter')choose();};}
      body.append(tr);
    }table.append(body);this.table.append(table);
  }
}
