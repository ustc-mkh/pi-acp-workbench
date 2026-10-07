// Explicit test-only transport injection; never shipped in VSIX.
import {main, TelegramApi} from '../dist/telegram-daemon.mjs';
await main(token=>new TelegramApi(token,1,fetch,process.env.PI_TELEGRAM_API_BASE));
