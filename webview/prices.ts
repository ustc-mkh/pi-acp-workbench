import type {Price,Statistics} from '../src/telemetry';
import {priceFor} from '../src/telemetry';
import type {UiMessage} from '../src/shared';
const labels=[['input','非缓存输入'],['cacheRead','缓存读取'],['cacheWrite','缓存写入'],['output','输出']] as const;
const text=(tag:string,value:string,className?:string)=>{const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el;};
interface Card {node:HTMLElement;fields:Map<(typeof labels)[number][0],HTMLInputElement>;source:HTMLElement;fingerprint:string;pending:boolean;dirty:boolean}
export class PricesPage {
  private cards=new Map<string,Card>();private list:HTMLElement;private empty:HTMLElement;
  constructor(root:HTMLElement,private send:(message:UiMessage)=>void,back:()=>void){
    root.className='prices-page';const header=text('div','','stats-heading'),button=text('button','返回统计') as HTMLButtonElement;button.type='button';button.onclick=back;header.append(text('h2','模型价格设置'),button);root.append(header);
    root.append(text('p','当前 Agent 已配置的模型 · USD / 百万 token。保存后重算统计；实际账单可能受订阅、长上下文及缓存时长影响。','stats-caption'));
    this.empty=text('p','暂无模型列表，请先连接 Agent。','stats-empty');this.list=text('div','','model-price-list');root.append(this.empty,this.list);
  }
  update(data?:Statistics){
    const models=[...new Map((data?.models||[]).map(m=>[m.id,m])).values()];this.empty.hidden=!!models.length;
    const ids=new Set(models.map(m=>m.id));for(const [id,card]of this.cards)if(!ids.has(id)){card.node.remove();this.cards.delete(id);}
    for(const [index,model]of models.entries()){
      let card=this.cards.get(model.id);
      if(!card){
        const node=text('section','','model-price-card');node.setAttribute('aria-label',model.id);node.append(text('h3',model.name||model.id));if(model.name!==model.id)node.append(text('p',model.id,'stats-caption'));
        card={node,fields:new Map(),source:text('p','','stats-caption'),fingerprint:'',pending:false,dirty:false};
        const grid=text('div','','price-grid');
        for(const [key,label]of labels){const input=document.createElement('input');input.type='number';input.min='0';input.max='1000000';input.step='any';input.required=true;input.oninput=()=>{const current=this.cards.get(model.id);if(current)current.dirty=true;};input.setAttribute('aria-label',`${model.id} ${label}价格`);const wrapper=document.createElement('label');wrapper.append(text('span',label),input);grid.append(wrapper);card.fields.set(key,input);}
        node.append(grid,card.source);
        const selected=card,save=text('button','保存价格','primary') as HTMLButtonElement,reset=text('button','恢复默认') as HTMLButtonElement;save.type=reset.type='button';
        save.onclick=()=>{for(const input of selected.fields.values())if(!input.reportValidity())return;selected.pending=true;selected.source.textContent='正在保存…';this.send({type:'setPrice',model:model.id,price:Object.fromEntries([...selected.fields].map(([key,input])=>[key,input.valueAsNumber])) as unknown as Price});};
        reset.onclick=()=>{selected.pending=true;this.send({type:'setPrice',model:model.id});};node.append(save,reset);this.cards.set(model.id,card);
      }
      if(this.list.children[index]!==card.node)this.list.insertBefore(card.node,this.list.children[index]||null);
      const price=priceFor(model.id,data?.prices||{}),fingerprint=JSON.stringify(price)||'unknown';
      if(card.pending||fingerprint!==card.fingerprint&&!card.dirty){for(const [key,input]of card.fields)input.value=price?String(price[key]):'';card.fingerprint=fingerprint;card.pending=false;card.dirty=false;card.source.textContent=price?(price.source==='用户设置'?'已保存 · 自定义单价':'默认单价'):'暂无默认单价，请填写四项价格。';}
    }
  }
  focus(model?:string){if(model)this.cards.get(model)?.node.scrollIntoView({block:'start'});}
}
