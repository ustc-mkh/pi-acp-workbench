import { telegramChunks, type TelegramTransport } from './telegram-api';

/** One coalesced preview per turn; the final text and completion notification are durable. */
export class TelegramStream {
  private text = '';
  private shown = '';
  private messageId?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private finished = false;
  private working = false;
  constructor(private api:TelegramTransport, private chatId:number, private threadId:number,
    private intervalMs=3100, private report:(error:unknown)=>void=()=>{}, private enabled:()=>boolean=()=>true) {}

  update(text:string) {
    if (this.finished || !this.enabled()) return;
    this.text = text;
    if (this.timer || this.working || text === this.shown) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.working = true;
      this.pending = this.preview().catch(this.report).finally(() => {
        this.working = false;
        if (!this.finished && this.text !== this.shown) this.update(this.text);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }
  private async preview() {
    if (this.finished || !this.enabled()) return;
    const text = this.text;
    const preview = text.length > 3800 ? '…（完整回复将在结束后补齐）\n' + text.slice(-3800) : text || '正在处理…';
    if (text === this.shown && this.messageId) return;
    if (this.messageId) await this.api.call('editMessageText', {chat_id:this.chatId,message_id:this.messageId,text:preview});
    else {
      const message = await this.api.call<{message_id:number}>('sendMessage', {
        chat_id:this.chatId,message_thread_id:this.threadId,text:preview,disable_notification:true,
      });
      this.messageId = message.message_id;
    }
    this.shown = text;
  }
  async finish(text:string, notification:string) {
    if (this.finished || !this.enabled()) return;
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pending;
    if(!this.enabled())return;
    const chunks = telegramChunks(text);
    if (this.messageId) {
      const first = chunks.shift() || '本轮没有文本回复。';
      // Avoid Telegram's "message is not modified" error on an already-final preview.
      if (first !== this.shown || this.shown.length > 3800) {
        await this.api.call('editMessageText', {chat_id:this.chatId,message_id:this.messageId,text:first});
      }
    }
    for (const chunk of chunks) {if(!this.enabled())return;await this.api.call('sendMessage', {
      chat_id:this.chatId,message_thread_id:this.threadId,text:chunk,disable_notification:true,
    });
    }
    if(this.enabled())await this.api.call('sendMessage', {chat_id:this.chatId,message_thread_id:this.threadId,text:notification,disable_notification:false});
  }
  dispose() { this.finished = true; if (this.timer) clearTimeout(this.timer); }
}
