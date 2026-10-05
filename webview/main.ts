import { createRenderer } from './markdown';
import { sessionSelectors, createSessionSelector } from './selectors';
import { contextUsage } from './usage';
import { installTooltips } from './tooltips';
import { HistoryList } from './history';
import { renderDiagrams } from './diagrams';
import { PricesPage } from './prices';
import { installImagePaste, imagePreview } from './image-paste';
import { StatisticsPage } from './statistics';
import { createMessageRenderer } from './messages';
import type { ChatState, UiMessage } from '../src/shared';
import { applyStatePatch } from '../src/state-channel';
import { sessionLabel } from '../src/session-numbers';
import { HARNESSES, isHarnessId, type HarnessId } from '../src/harness';
import { TranscriptView } from './transcript';
import { installComposerResize } from './composer-resize';
import { SlashCommands } from './slash-commands';
interface UiState {drafts?:Partial<Record<HarnessId,string>>;composerHeight?:number;activityExpanded?:boolean}
declare function acquireVsCodeApi(): { postMessage(message: UiMessage): void; getState(): UiState | undefined; setState(state: UiState): void };
const vscode = acquireVsCodeApi();
const saveUi = (patch:UiState) => vscode.setState({...vscode.getState(),...patch});
const renderMarkdown = createRenderer(window);
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<header><div class="brand"><span id="harness-logo" class="logo">π</span><select id="harness-switch" aria-label="切换 Harness" data-tooltip="切换 Harness；保存当前会话，不自动发送或创建新会话"><option value="pi">Pi Agent</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select><span class="protocol">ACP</span></div><div class="toolbar"><button id="history-toggle" aria-controls="history" aria-expanded="false" data-tooltip="历史记录" aria-label="历史记录">◷</button><button id="export" data-tooltip="导出 Markdown" aria-label="导出 Markdown">↧</button><button id="copy-conversation" data-tooltip="复制完整对话原文" aria-label="复制完整对话">⧉</button><button id="statistics-toggle" data-tooltip="用量统计" aria-label="用量统计" aria-pressed="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 16h14M5 13V9M10 13V4M15 13V7"/></svg></button><button id="new" data-tooltip="新对话" aria-label="新对话">＋</button></div></header><div id="chat-page" class="chat-page">
<details id="harness-help" hidden><summary id="harness-help-title"></summary><p id="harness-note"></p><p id="harness-auth"></p><p>请在扩展宿主（SSH 时为服务器）安装 ACP 适配器：</p><code id="harness-install"></code><p>安装不会自动执行。配置 command / args / env 后新建会话；认证失败时先完成登录或配置该 harness 的 API key。</p><button id="harness-login">打开登录终端</button></details>
<section id="history" hidden><div class="section-label">会话历史 <span><button id="refresh-history" data-tooltip="刷新共享会话">刷新</button><button id="clear-history" data-tooltip="清除历史记录（共享模式下影响所有客户端）">清空</button></span></div><div id="history-items"></div></section>
<div id="connection" hidden><span class="status-dot"></span><span id="session-number" class="session-number" hidden></span><span id="status" role="status"></span><button id="release-session" hidden data-tooltip="断开当前界面；服务中的 Pi 任务仍可继续">释放会话</button><button id="connect" hidden>重新连接</button></div>
<div class="transcript-tools"><button id="toggle-activity" aria-pressed="false" data-tooltip="整体展开或折叠工具调用、思考和中间过程">展开执行过程</button></div>
<div id="context-operation" hidden role="status"><span id="context-progress"></span><button id="cancel-context">取消</button></div><div id="error" role="alert" hidden><span id="error-message"></span><button id="dismiss-error" aria-label="关闭错误提示" data-tooltip="关闭错误提示">×</button></div>
<div class="transcript-area"><main id="transcript" aria-label="对话记录" tabindex="0"><section id="welcome"><div class="hero-icon">π</div><h1>从一个想法开始。</h1><p>代码、推导、探索。<br><span id="welcome-harness">让 Pi 在你的工作区里协助你。</span></p><button id="start-session">新建会话</button><button id="demo">预览 Markdown 与公式 <span>↗</span></button><small>通过 ACP 连接本地 Agent</small></section><div id="messages"></div><div id="working" hidden><span class="session-indicator running" aria-hidden="true"></span> <span id="working-label">Pi 正在处理…</span></div></main>
<button id="bottom" class="primary" aria-label="回到最新消息" data-tooltip="回到最新消息" hidden>↓</button></div>
<section id="plan" aria-label="执行计划" hidden></section><section id="permissions" aria-label="操作授权" aria-live="polite"></section>
<div id="composer-resizer" role="separator" tabindex="0" aria-label="调整输入区高度" aria-orientation="horizontal" aria-controls="input" data-tooltip="拖动调整输入区高度 · 方向键微调 · 双击重置"></div><footer><div id="attachments"></div><div class="composer"><textarea id="input" aria-label="向 Pi 发送消息" placeholder="描述任务，或输入 / 查看命令…" rows="3"></textarea><div id="commands" hidden></div><div class="composer-tools"><button id="attach" data-tooltip="添加当前编辑器的选区或文件">＋ 上下文</button><div id="selectors"></div><span id="hint">Enter 发送 · Shift+Enter 换行</span><div class="composer-actions"><div id="usage" role="img" tabindex="0" aria-label="上下文占用"><svg viewBox="0 0 24 24" aria-hidden="true"><circle class="usage-track" cx="12" cy="12" r="8"/><circle id="usage-fill" cx="12" cy="12" r="8" pathLength="100" transform="rotate(-90 12 12)"/></svg></div><button id="stop" hidden>■ 停止</button><button id="send" class="primary" aria-label="发送消息" data-tooltip="Enter 发送 · Shift+Enter 换行">↑</button></div></div></div></footer></div><section id="statistics" hidden aria-label="用量统计"></section><section id="prices" hidden aria-label="模型价格设置"></section>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
installTooltips();
const input = el<HTMLTextAreaElement>('input');
let draftHarness: HarnessId = 'pi';
input.value = vscode.getState()?.drafts?.pi ?? '';
const saveDraft = () => saveUi({drafts:{...vscode.getState()?.drafts,[draftHarness]:input.value}});
installComposerResize(el('composer-resizer'),input,vscode.getState()?.composerHeight,height=>saveUi({composerHeight:height}));
const send = (message: UiMessage) => vscode.postMessage(message);
let state: ChatState | undefined;
let stateRevision = 0;
let followBottom = true;
let sending = false;
let pasting=false;
installImagePaste(input,()=>state?.sessionId,send,value=>{pasting=value;updateSend();},()=>state?.harness || 'pi');
let paintPending = false;
let activityExpanded = vscode.getState()?.activityExpanded || false;
const transcriptView = new TranscriptView(el('messages'),createMessageRenderer(renderMarkdown,()=>state?.sessionId,send),activityExpanded);
const updateActivityButton = () => {el('toggle-activity').textContent = activityExpanded ? '折叠执行过程' : '展开执行过程';el('toggle-activity').setAttribute('aria-pressed',String(activityExpanded));};
updateActivityButton();
el('toggle-activity').onclick = () => {activityExpanded = !activityExpanded;transcriptView.setExpanded(activityExpanded);saveUi({activityExpanded});updateActivityButton();};
const button = (text: string, action: () => void, className?: string) => {
  const b = document.createElement('button'); b.textContent = text; b.type = 'button';
  if (className) b.className = className; b.addEventListener('click', action); return b;
};
const slashCommands = new SlashCommands(input,el('commands'),()=>{saveDraft();updateSend();});
function submit() {
  if ((!input.value.trim()&&!state?.attachments.some(a=>a.kind==='image')) || state?.status !== 'ready' || sending || pasting) return;
  followBottom = true;
  el('transcript').scrollTop = el('transcript').scrollHeight;
  el('bottom').hidden = true;
  sending = true; send({ type: 'send', text: input.value });
}
input.addEventListener('keydown', event => {
  if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
});
input.addEventListener('input', () => { saveDraft(); updateSend(); });
el('harness-switch').onchange = () => {
  const harness=el<HTMLSelectElement>('harness-switch').value;
  if(isHarnessId(harness)){saveDraft();showStatistics(false);send({type:'switchHarness',harness});}
};
el('harness-login').onclick = () => send({type:'login'});
el('send').onclick = submit;
el('stop').onclick = () => send({ type: 'cancel' });
el('start-session').onclick = () => send({ type: 'new' });
el('connect').onclick = () => send({ type: 'connect' });
el('release-session').onclick = () => send({type:'releaseSession'});
el('refresh-history').onclick = () => send({type:'refreshHistory'});
el('dismiss-error').onclick = () => {
  if (state?.error) send({ type: 'dismissError', error: state.error });
  el('error').hidden = true;
};
el('new').onclick = () => {showStatistics(false);send({ type: 'new' });};
el('attach').onclick = () => send({ type: 'attach' });
el('export').onclick = () => send({ type: 'export' });
el('copy-conversation').onclick = () => send({type:'copyConversation'});
el('cancel-context').onclick = () => send({type:'cancelContext'});
let statisticsOpen=false,pricesOpen=false;
const showStatistics=(show:boolean)=>{statisticsOpen=show;pricesOpen=false;el('prices').hidden=true;el('statistics').hidden=!show;el('chat-page').hidden=show;el('statistics-toggle').setAttribute('aria-pressed',String(show));if(show){statisticsPage.update(state?.statistics);send({type:'refreshStatistics'});}else requestAnimationFrame(()=>{renderDiagrams(el('messages'));});};
const showPrices=(model?:string)=>{statisticsOpen=true;pricesOpen=true;el('statistics').hidden=true;el('prices').hidden=false;el('chat-page').hidden=true;pricesPage.update(state?.statistics);pricesPage.focus(model);};
const statisticsPage=new StatisticsPage(el('statistics'),send,()=>showStatistics(false),showPrices);
const pricesPage=new PricesPage(el('prices'),send,()=>showStatistics(true));
el('statistics-toggle').onclick=()=>showStatistics(pricesOpen||!statisticsOpen);
el('demo').onclick = () => send({ type: 'preview' });
el('clear-history').onclick = () => send({ type: 'clearHistory' });
const closeHistory = () => { el('history').hidden = true; el('history-toggle').setAttribute('aria-expanded', 'false'); };
const historyList = new HistoryList(el('history-items'), send, closeHistory);
el('history-toggle').onclick = () => {
  if(statisticsOpen)showStatistics(false);
  el('history').hidden = !el('history').hidden;
  el('history-toggle').setAttribute('aria-expanded', String(!el('history').hidden));
  if(!el('history').hidden) send({type:'refreshHistory'});
};
el('bottom').onclick = () => { followBottom = true; el('transcript').scrollTop = el('transcript').scrollHeight; el('bottom').hidden = true; };
el('messages').addEventListener('load',event=>{if(event.target instanceof HTMLImageElement&&followBottom)el('transcript').scrollTop=el('transcript').scrollHeight;},true);
el('transcript').addEventListener('scroll', () => {
  const t = el('transcript'); followBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  el('bottom').hidden = followBottom;
});
app.addEventListener('click', async event => {
  const target = (event.target as Element).closest('a, .copy-code');
  if (!target) return;
  event.preventDefault();
  if (target.matches('a')) {
    const url = target.getAttribute('href') || '';
    if (url.startsWith('#')) { try { document.getElementById(decodeURIComponent(url.slice(1)))?.scrollIntoView(); } catch { /* malformed anchor */ } }
    else send({ type: 'open', url });
  }
  else {
    try { await navigator.clipboard.writeText(target.parentElement?.querySelector('code')?.textContent || ''); target.textContent = '已复制'; }
    catch { target.textContent = '复制失败'; }
    setTimeout(() => { target.textContent = '复制'; }, 1500);
  }
});
function updateSend() { el<HTMLButtonElement>('send').disabled = state?.status !== 'ready' || (!input.value.trim()&&!state?.attachments.some(a=>a.kind==='image')) || sending || pasting; }
function paint() {
  paintPending = false;
  if (!state) return;
  const busy = state.status === 'busy', connecting = state.status === 'connecting';
  const harness=state.harness || 'pi', profile=HARNESSES[harness];
  el<HTMLSelectElement>('harness-switch').value=harness;
  el<HTMLSelectElement>('harness-switch').disabled=busy||connecting||pasting;
  el('harness-logo').textContent=harness==='pi'?'π':harness==='codex'?'>_':'C';
  el('harness-help').hidden=harness==='pi';
  el('harness-help-title').textContent=`${profile.name} · ACP 部分支持 / 安装与登录`;
  el('harness-note').textContent=profile.note;
  el('harness-auth').textContent=profile.loginHint;
  el('harness-install').textContent=profile.install;
  el('welcome-harness').textContent=`让 ${profile.name} 在你的工作区里协助你。`;
  el('working-label').textContent=`${profile.name} 正在处理…`;
  input.setAttribute('aria-label',`向 ${profile.name} 发送消息`);
  const reconnect = state.status === 'disconnected' && !!state.sessionId && !!state.connectionAttempted && !state.preview;
  el('connection').hidden = !connecting && !reconnect && !state.preview && !state.sessionId;
  el('release-session').hidden = !state.sessionId || !!state.readOnly || state.preview;
  el<HTMLButtonElement>('release-session').disabled = busy || connecting;
  el('status').textContent = state.preview ? '渲染预览 · 离线' : state.readOnly ? '只读查看' : connecting ? '正在连接…' : state.status === 'disconnected' ? '未连接' : '';
  el('connection').dataset.status = state.status;
  el('session-number').hidden = !state.sessionId || state.preview;
  el('session-number').textContent = sessionLabel(state.sessionNumber,state.sessionId);
  el('session-number').dataset.tooltip = `会话 ${sessionLabel(state.sessionNumber,state.sessionId)}\nSession ID: ${state.sessionId || ''}`;
  el('connect').hidden = !reconnect;
  el<HTMLButtonElement>('connect').disabled = connecting;
  el<HTMLButtonElement>('new').disabled = busy || connecting;
  el('stop').hidden = !busy; el('send').hidden = busy; el('working').hidden = !busy;
  el('error').hidden = !state.error; el('error-message').textContent = state.error || '';
  el('welcome').hidden = !!state.entries.length;
  el('start-session').hidden = !!state.sessionId || !!state.preview;
  el<HTMLButtonElement>('start-session').disabled = busy || connecting;
  input.disabled = connecting;
  updateSend();
  const messages = el('messages');
  const visible = state.entries.filter(e => e.role !== 'thought' || state!.showThoughts);
  transcriptView.update(visible,busy);
  el('toggle-activity').hidden = !visible.some(entry=>entry.role==='tool'||entry.role==='thought');
  for (const action of messages.querySelectorAll<HTMLButtonElement>('[data-context-action]')) {
    const nativePoint=!!state.nativeForks?.[action.dataset.entryId || ''];
    action.disabled = harness!=='pi' || state.status!=='ready' || !!state.preview || !!state.readOnly || !state.sessionId || !nativePoint;
    action.dataset.tooltip = harness!=='pi' ? '此 harness 暂不支持原生分支' : busy ? '请先停止输出再分支' : !nativePoint ? '此消息没有可验证的安全原生位置；不会退回摘要重建' : action.dataset.actionDescription;
  }
  el('context-operation').hidden=!state.contextOperation;
  el('context-progress').textContent = state.contextOperation?.kind === 'fork' ? '正在创建原生分支…' : '';
  if(!statisticsOpen)renderDiagrams(messages);
  if(statisticsOpen&&!pricesOpen)statisticsPage.update(state.statistics);
  if(pricesOpen)pricesPage.update(state.statistics);
  const attachments = el('attachments'); attachments.replaceChildren();
  for (const a of state.attachments) { if(a.kind==='image'){const item=document.createElement('div');item.className='image-attachment';const img=imagePreview(a.mimeType,a.data,a.name);if(img)item.append(img);const remove=button('×',()=>send({type:'removeAttachment',id:a.id}));remove.setAttribute('aria-label',`移除图片 ${a.name}`);remove.dataset.tooltip='移除此图片';item.append(remove);attachments.append(item);continue;} const b = button(`📎 ${a.name} ×`, () => send({ type: 'removeAttachment', id: a.id })); b.dataset.tooltip = '移除此上下文'; attachments.append(b); }
  const plan = el('plan'); plan.hidden = !state.plan.length; plan.replaceChildren();
  for (const item of state.plan) { const p = document.createElement('div'); p.textContent = `${item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'} ${item.content}`; plan.append(p); }
  // Do not replace focused permission buttons on every streaming update.
  const permissions = el('permissions'); const permissionSignature = JSON.stringify([state.permissions]);
  if (permissions.dataset.signature !== permissionSignature) {
    permissions.dataset.signature = permissionSignature; permissions.replaceChildren();
    for (const item of state.permissions) {
      const card = document.createElement('div'); card.className = 'permission-card';
      const h = document.createElement('strong'); h.textContent = `需要授权 · ${item.request.toolCall.title || '工具操作'}`; card.append(h);
      const details = document.createElement('pre'); details.textContent = JSON.stringify(item.request.toolCall, null, 2); card.append(details);
      const actions = document.createElement('div'); actions.className = 'permission-actions';
      for (const option of item.request.options) actions.append(button(option.name, () => send({ type: 'permission', id: item.id, optionId: option.optionId }), option.kind.startsWith('reject') ? '' : 'primary'));
      actions.append(button('取消', () => send({ type: 'permission', id: item.id }))); card.append(actions); permissions.append(card);
    }
  }
  const selectors = el('selectors'); const selectSignature = JSON.stringify([state.harness, state.modes, state.configs, state.status, state.readOnly]);
  if (selectors.dataset.signature !== selectSignature) {
    selectors.dataset.signature = selectSignature; selectors.replaceChildren();
    for (const control of sessionSelectors(state)) {
      selectors.append(createSessionSelector(control, state.status !== 'ready' || !!state.readOnly, value => send({ ...control.change, value })));
    }
  }
  const usage = contextUsage(state.usage);
  el('usage').dataset.tooltip = usage.label;
  el('usage').setAttribute('aria-label', usage.known ? `上下文占用 ${usage.label}` : usage.label);
  el('usage').dataset.level = !usage.known ? 'unknown' : usage.percent >= 90 ? 'high' : 'normal';
  el('usage-fill').setAttribute('stroke-dasharray', `${usage.percent} 100`);
  historyList.update(state);
  if (followBottom) el('transcript').scrollTop = el('transcript').scrollHeight;
  slashCommands.update(state.commands,state.status);
}
window.addEventListener('message', event => {
  if (event.data.type === 'sent') { input.value = ''; saveDraft(); sending = false; updateSend(); return; }
  if (event.data.type === 'statePatch') {
    if (!state || event.data.revision !== stateRevision + 1) { send({type:'ready'}); return; }
    state = applyStatePatch(state, event.data);
    stateRevision = event.data.revision;
  } else if (event.data.type === 'state') {
    if (state?.sessionId !== event.data.state?.sessionId) followBottom = true;
    state = event.data.state;
    stateRevision = event.data.revision || 0;
  } else return;
  const nextHarness=state?.harness || 'pi';
  if(nextHarness!==draftHarness){
    saveDraft();draftHarness=nextHarness;
    input.value=vscode.getState()?.drafts?.[draftHarness] ?? '';
    followBottom=true;
  }
  if (state?.status !== 'busy') sending = false;
  if (!paintPending) { paintPending = true; requestAnimationFrame(paint); }
});
new MutationObserver(()=>renderDiagrams(el('messages'))).observe(document.body,{attributes:true,attributeFilter:['class']});
send({ type: 'ready' });
