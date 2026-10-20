import { isAbsolute } from 'node:path';
/** Generate only a new config; never pair by accepting an untrusted first sender. */
export function telegramConfiguration(input: {
  workspace: string;
  root: string;
  tokenEnv: string;
  user: string;
  chat: string;
}) {
  if (!isAbsolute(input.workspace) || !isAbsolute(input.root) || input.root === '/')
    throw new Error('Choose absolute workspace/storage directories');
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(input.tokenEnv))
    throw new Error('Use an environment variable name, not a Bot token');
  const id = (text: string) => {
    if (!/^-?[1-9]\d{0,15}$/.test(text) || !Number.isSafeInteger(Number(text)))
      throw new Error('Telegram IDs must be nonzero safe integers');
    return Number(text);
  };
  const user = id(input.user),
    chat = id(input.chat);
  if (user <= 0) throw new Error('The authorized user ID must be positive');
  return {
    workers: { pi: { command: 'pi-acp', args: [], env: {} }, codex: null, claude: null },
    sessions: { mailbox: 128, max_workers: 16 },
    storage: { root: input.root },
    limits: { pending_interactions: 32 },
    telegram: {
      bot_token_env: input.tokenEnv,
      workspace: input.workspace,
      allowed_chat_ids: [chat],
      allowed_user_ids: [user],
      api_base: 'https://api.telegram.org/',
      inbox_capacity: 128,
    },
  };
}
