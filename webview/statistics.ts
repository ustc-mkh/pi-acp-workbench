import type { Statistics, Price, UsageRecord } from '../src/telemetry';
import { groupUsage, priceFor, dayKey } from '../src/telemetry';
import type { UiMessage } from '../src/shared';
const text=(tag:string,value:string,className?:string)=>{const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el;};
const number=(n:number)=>n.toLocaleString(undefined,{maximumFractionDigits:0});
const money=(n:number)=>'$'+n.toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4});
export class StatisticsPage {
  private data?:Statistics;
  private priceFingerprint='';
  private by:'model'|'day'|'session'='model';
  private from:HTMLInputElement;private until:HTMLInputElement;private table:HTMLElement;private totals:HTMLElement;private note:HTMLElement;
  private model:HTMLInputElement;private fields:Record<keyof Pick<Price,'input'|'output'|'cacheRead'|'cacheWrite'>,HTMLInputElement>;private source:HTMLElement;private models:HTMLDataListElement;
  constructor(private root:HTMLElement,private send:(m:UiMessage)=>void,back:()=>void) {
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
    const settings=document.createElement('details');settings.className='stats-prices';settings.append(text('summary','模型价格设置'));
    settings.append(text('p','每百万 token 的标准 API 估算价格。修改后立即重算统计；订阅、优惠、长上下文及不同缓存保留时长可能导致实际账单不同。','stats-caption'));
    this.model=document.createElement('input');this.model.setAttribute('aria-label','模型标识');this.model.placeholder='例如 openai-codex/gpt-6-astra';this.model.setAttribute('list','stats-model-prices');
    this.models=document.createElement('datalist');this.models.id='stats-model-prices';settings.append(this.model,this.models);
    this.fields={} as typeof this.fields;
    const grid=text('div','','price-grid');
    for(const [key,label] of [['input','非缓存输入'],['cacheRead','缓存读取'],['cacheWrite','缓存写入'],['output','输出']] as const){const field=document.createElement('input');field.type='number';field.min='0';field.max='1000000';field.step='any';field.required=true;field.setAttribute('aria-label',label+'价格');const wrapper=document.createElement('label');wrapper.append(text('span',label+' / 1M'),field);grid.append(wrapper);this.fields[key]=field;}
    settings.append(grid);this.source=text('p','','stats-caption');settings.append(this.source);
    const save=text('button','保存价格','primary') as HTMLButtonElement;save.type='button';save.onclick=()=>{if(!this.model.value.trim())return this.model.focus();for(const field of Object.values(this.fields))if(!field.reportValidity())return;this.send({type:'setPrice',model:this.model.value.trim(),price:Object.fromEntries(Object.entries(this.fields).map(([k,v])=>[k,v.valueAsNumber])) as unknown as Price});this.source.textContent='价格已提交';};
    const reset=text('button','恢复默认') as HTMLButtonElement;reset.type='button';reset.onclick=()=>{if(this.model.value.trim())this.send({type:'setPrice',model:this.model.value.trim()});};settings.append(save,reset);this.model.onchange=()=>this.fillPrice();root.append(settings);
  }
  update(data?:Statistics) {this.data=data;if(this.model.value&&JSON.stringify(priceFor(this.model.value.trim(),data?.prices||{}))!==this.priceFingerprint)this.fillPrice();this.render();const names=new Set([...Object.keys(data?.prices||{}),...(data?.records||[]).map(r=>r.model)]);this.models.replaceChildren(...[...names].sort().map(n=>{const o=document.createElement('option');o.value=n;return o;}));}
  private fillPrice(){const p=priceFor(this.model.value.trim(),this.data?.prices||{});this.priceFingerprint=JSON.stringify(p);for(const key of Object.keys(this.fields) as (keyof typeof this.fields)[])this.fields[key].value=p?String(p[key]):'';this.source.textContent=p?`${p.source||'预置价格'}${p.updated?' · '+p.updated:''}`:'暂无预置价格，请填写。';}
  private render(){
    const data=this.data,records=(data?.records||[]).filter(r=>{const day=dayKey(r.timestamp);return (!this.from.value||day>=this.from.value)&&(!this.until.value||day<=this.until.value);});
    this.note.textContent=data?.note||(!data?.available?'当前连接未提供详细用量；连接内置 Pi ACP 适配器后自动记录。已有统计仍保留。':'统计来自 Pi 返回的请求用量，费用按下面的价格估算。');
    this.totals.replaceChildren();
    const grouped=groupUsage(records.map(r=>({...r,model:'all'})),{all:{input:0,output:0,cacheRead:0,cacheWrite:0}},'model')[0];
    const groups=groupUsage(records,data?.prices||{},'model'), cost=groups.reduce((s,g)=>s+g.cost,0), unknown=groups.reduce((s,g)=>s+g.unpriced,0);
    for(const [label,value] of [['总输入',number(grouped?.totalInput||0)],['输出',number(grouped?.output||0)],['缓存命中',grouped?.cacheRate===undefined?'—':(grouped.cacheRate*100).toFixed(1)+'%'],['估算费用',money(cost)+(unknown?' + 未定价':'')]]){const card=text('div','','stats-card');card.append(text('span',label),text('strong',value));this.totals.append(card);}
    const rows=groupUsage(records,data?.prices||{},this.by);this.table.replaceChildren();
    if(!rows.length){this.table.append(text('p','此范围暂无用量记录。','stats-empty'));return;}
    const table=document.createElement('table'),head=document.createElement('thead'),header=document.createElement('tr');
    for(const label of [this.by==='model'?'模型':this.by==='day'?'日期':'会话','缓存命中','总输入','输出','命中率','估算费用','Pi 报告费用'])header.append(text('th',label));head.append(header);table.append(head);
    const body=document.createElement('tbody');
    for(const row of rows){const tr=document.createElement('tr');const name=this.by==='session'?data?.titles[row.key]||row.key:row.key;
      const first=text('td',name);first.dataset.tooltip=this.by==='session'?`${name}\n${row.key}`:name;tr.append(first);
      for(const value of [number(row.cacheRead),number(row.totalInput),number(row.output),row.cacheRate===undefined?'—':(row.cacheRate*100).toFixed(1)+'%',money(row.cost)+(row.unpriced?' + 未定价':''),row.unreported===row.calls?'—':money(row.reportedCost)+(row.unreported?' + 未报告':'')])tr.append(text('td',value));
      if(this.by==='model'){first.tabIndex=0;first.className='stats-model-link';const choose=()=>{this.model.value=row.key;this.fillPrice();(this.root.querySelector('.stats-prices') as HTMLDetailsElement).open=true;this.model.scrollIntoView({block:'nearest'});};first.onclick=choose;first.onkeydown=e=>{if(e.key==='Enter')choose();};}
      body.append(tr);
    }table.append(body);this.table.append(table);
  }
}
