import { setTimeout as delay } from 'node:timers/promises';

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: {id:number;type:string};
  from?: {id:number;is_bot?:boolean};
  sender_chat?: unknown;
  text?: string;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {id:string;from:{id:number;is_bot?:boolean};message?:TelegramMessage;data?:string};
}
export interface TelegramTransport {
  call<T>(method:string, params?:Record<string,unknown>):Promise<T>;
  dispose():void;
}
export class TelegramApiError extends Error {
  constructor(readonly code:number, message:string) { super(message); }
}

/** Telegram token stays in memory; errors never expose the credential-bearing URL. */
export class TelegramApi implements TelegramTransport {
  private abort = new AbortController();
  private outgoing: Promise<unknown> = Promise.resolve();
  private nextSend = 0;
  private queued=0;
  constructor(private token:string, private intervalMs=Number(process.env.PI_TELEGRAM_PACE_MS)||3100, private fetcher:typeof fetch=fetch) {}

  call<T>(method:string, params:Record<string,unknown>={}):Promise<T> {
    const paced = ['sendMessage','editMessageText','createForumTopic'].includes(method);
    if (!paced) return this.request<T>(method, params);
    if(this.queued>=64)return Promise.reject(new Error('Telegram 发送队列已满，请稍后重试。'));
    this.queued++;
    const result = this.outgoing.catch(() => {}).then(async () => {
      const wait = this.nextSend - Date.now();
      if (wait > 0) await delay(wait, undefined, {signal:this.abort.signal});
      this.abort.signal.throwIfAborted();
      try { return await this.request<T>(method, params); }
      finally { this.nextSend = Date.now() + this.intervalMs; }
    });
    const finished=result.finally(()=>{this.queued--;});
    this.outgoing = finished.then(()=>{},()=>{});
    return finished;
  }

  private async request<T>(method:string, params:Record<string,unknown>):Promise<T> {
    for (let attempt=0; ; attempt++) {
      let result: {ok:boolean;result:T;error_code?:number;description?:string;parameters?:{retry_after?:number}};
      try {
        // PI_TELEGRAM_API_BASE (testing only) replaces the bot<token> URL prefix.
        const base=(process.env.PI_TELEGRAM_API_BASE||`https://api.telegram.org/bot${this.token}`).replace(/\/+$/,'');
        const response = await this.fetcher(`${base}/${method}`, {
          method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(params),
          signal:AbortSignal.any([this.abort.signal, AbortSignal.timeout(method==='getUpdates'?40000:20000)]),
        });
        result = await response.json() as typeof result;
      } catch {
        if (this.abort.signal.aborted) throw new Error('Telegram 已停止。');
        // Do not retry ambiguous network failures: a send may already have succeeded.
        throw new Error('Telegram 网络请求失败或超时，请检查服务器到 api.telegram.org 的连接。');
      }
      if (result.ok) return result.result;
      const retry = result.parameters?.retry_after;
      if (result.error_code === 429 && attempt < 2 && Number.isFinite(retry) && retry! > 0 && retry! <= 120) {
        await delay(retry! * 1000, undefined, {signal:this.abort.signal});
        continue;
      }
      throw new TelegramApiError(result.error_code || 0,
        `Telegram: ${(result.description || 'API 请求失败').split(this.token).join('[redacted]').slice(0,500)}`);
    }
  }
  dispose() { this.abort.abort(); }
}

/** Stay below Telegram's 4096-character limit without splitting a surrogate pair. */
export function telegramChunks(text:string, limit=3900):string[] {
  const chunks:string[] = [];
  while (text.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end-1])) end--;
    chunks.push(text.slice(0,end)); text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}
