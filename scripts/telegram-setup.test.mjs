import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  botApi,
  configureTelegram,
  findServiceDir,
  serviceUnit,
  readSecret,
  run,
} from './lib/telegram-setup.mjs';

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const bot = { id: 123456, is_bot: true, username: 'test_bot' };
const oldConfig = {
  chatId: -100111,
  allowedUserIds: [42],
  workspaces: {},
  restrictToWorkspaces: true,
};

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pi-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const serviceDir = join(home, '程序 100% $release');
  await mkdir(serviceDir);
  for (const file of ['pi-acp-telegram-daemon', 'pi-acp-session-daemon'])
    await writeFile(join(serviceDir, file), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const configDir = join(home, '.config/pi-acp-workbench');
  const unitDir = join(home, '.config/systemd/user');
  const calls = [],
    apiCalls = [],
    logs = [],
    prompts = [];
  let enabled = !!options.active,
    active = !!options.active,
    code;
  const ask = async (prompt) => {
    prompts.push(prompt);
    return options.answer?.(prompt) ?? '';
  };
  const log = (text) => {
    logs.push(text);
    code = text.match(/\/setup_[a-f0-9]+/)?.[0] || code;
  };
  const api = async (method, params) => {
    apiCalls.push([method, params]);
    if (options.api) {
      const result = options.api(method, params, code);
      if (result !== undefined) return result;
    }
    if (method === 'getMe') return bot;
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getChat')
      return { id: -100111, type: 'supergroup', is_forum: true, title: '私人群' };
    if (method === 'getChatMember') return { status: 'administrator', can_manage_topics: true };
    if (method === 'getUpdates')
      return params.timeout === 0
        ? []
        : [
            {
              update_id: 1,
              message: {
                text: '/help',
                from: { id: 99 },
                chat: { id: -100222, type: 'supergroup', is_forum: true },
              },
            },
            {
              update_id: 2,
              message: {
                text: code + '@test_bot',
                from: { id: 42, is_bot: false },
                chat: { id: -100111, type: 'supergroup', is_forum: true },
              },
            },
          ];
    throw new Error('unexpected API: ' + method);
  };
  const execute = async (cmd, args) => {
    calls.push([cmd, args]);
    assert.notEqual(cmd, 'sudo');
    if (options.execute) {
      const result = options.execute(cmd, args);
      if (result !== undefined) return result;
    }
    if (cmd === 'systemctl') {
      assert.deepEqual(args.slice(0, 2), ['--user', '--no-ask-password']);
      const method = args[2];
      if (method === 'is-active')
        return { code: active ? 0 : 3, stdout: active ? 'active' : 'inactive' };
      if (method === 'is-enabled')
        return { code: enabled ? 0 : 1, stdout: enabled ? 'enabled' : 'disabled' };
      if (method === 'show')
        return {
          code: 0,
          stdout: args.includes('InvocationID')
            ? 'a'.repeat(32)
            : options.newSessions
              ? 'not-found'
              : 'loaded',
        };
      if (method === 'stop' && args.includes('pi-telegram.service')) {
        if (!active) return { code: 5, stdout: '', stderr: 'Unit not loaded' };
        active = false;
      }
      if (method === 'start' && args.includes('pi-telegram.service')) active = true;
      if (method === 'enable') {
        active = true;
        enabled = true;
      }
      if (method === 'disable') enabled = false;
    }
    if (cmd === 'journalctl') {
      assert(args.includes('_SYSTEMD_INVOCATION_ID=' + 'a'.repeat(32)));
      return { code: 0, stdout: 'Telegram relay ready: @test_bot, workbench' };
    }
    if (cmd === 'loginctl') return { code: 0, stdout: 'yes' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const setup = () =>
    configureTelegram({
      serviceDir,
      ask,
      secret: async () => token,
      log,
      execute,
      apiFactory: () => api,
      home,
      configHome: join(home, '.config'),
      wait: async () => {},
    });
  const seed = async () => {
    await mkdir(configDir, { recursive: true });
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(configDir, 'telegram.json'),
      JSON.stringify({ ...oldConfig, workspaces: { project: home } }),
    );
    await writeFile(
      join(configDir, 'telegram.env'),
      `PI_TELEGRAM_BOT_TOKEN=${token}\nCUSTOM_SETTING=keep\n`,
    );
    await writeFile(join(unitDir, 'pi-telegram.service'), 'old telegram unit\n');
    await writeFile(join(unitDir, 'pi-sessions.service'), 'untouched sessions unit\n');
    await writeFile(join(configDir, 'sessions.json'), '{"maxWorkers":2}\n');
  };
  return { home, serviceDir, configDir, unitDir, calls, apiCalls, logs, prompts, setup, seed };
}

test('pairs only the explicit code, stores private config and enables user services without sudo', async (t) => {
  const f = await fixture(t, { newSessions: true });
  const result = await f.setup();
  assert.equal(result.linger, true);
  assert.deepEqual(result.config.allowedUserIds, [42]);
  assert.equal(result.config.chatId, -100111);
  assert.deepEqual(result.config.workspaces, {});
  assert.equal(result.config.restrictToWorkspaces, false);
  assert.equal(
    await readFile(join(f.configDir, 'telegram.json.sync-request'), 'utf8'),
    'preview\n',
  );
  assert.equal((await stat(join(f.configDir, 'telegram.json.sync-request'))).mode & 0o777, 0o600);
  assert(!f.prompts.some((prompt) => prompt.includes('目录') || prompt.includes('工作区')));
  assert(f.logs.some((text) => text.includes('/new /项目的绝对路径')));
  const stored = JSON.parse(await readFile(join(f.configDir, 'telegram.json'), 'utf8'));
  assert.equal(JSON.stringify(stored).includes(token), false);
  assert.equal((await stat(f.configDir)).mode & 0o777, 0o700);
  for (const name of ['telegram.json', 'telegram.env'])
    assert.equal((await stat(join(f.configDir, name))).mode & 0o777, 0o600);
  assert(
    f.apiCalls.some(
      ([method, params]) => method === 'getUpdates' && params.offset === 3 && params.timeout === 0,
    ),
  );
  assert(
    f.calls.some(
      ([cmd, args]) => cmd === 'systemctl' && args.includes('enable') && args.includes('--now'),
    ),
  );
  assert(f.logs.every((text) => !text.includes(token)));
  assert((await readFile(join(f.unitDir, 'pi-sessions.service'), 'utf8')).includes('PATH='));
});

test('repeat setup reuses validated IDs, backs up secrets privately and leaves session settings alone', async (t) => {
  const f = await fixture(t, { active: true });
  await f.seed();
  const result = await f.setup();
  assert(f.apiCalls.every(([method]) => method !== 'getUpdates'));
  assert.deepEqual(result.config.workspaces, { project: f.home });
  assert.equal(result.config.restrictToWorkspaces, true);
  assert.equal(
    await readFile(join(f.unitDir, 'pi-sessions.service'), 'utf8'),
    'untouched sessions unit\n',
  );
  assert.equal(await readFile(join(f.configDir, 'sessions.json'), 'utf8'), '{"maxWorkers":2}\n');
  assert.equal((await stat(result.backup)).mode & 0o777, 0o700);
  assert.equal((await stat(join(result.backup, 'telegram.env'))).mode & 0o777, 0o600);
  assert(
    (await readFile(join(f.configDir, 'telegram.env'), 'utf8')).includes('CUSTOM_SETTING=keep'),
  );
  assert(!f.calls.some(([, args]) => args[2] === 'stop' && args.includes('pi-sessions.service')));
});

test('existing users can remove directory restrictions while retaining shortcut aliases', async (t) => {
  const f = await fixture(t, {
    active: true,
    answer: (prompt) => (prompt.startsWith('保留现有目录限制') ? 'n' : ''),
  });
  await f.seed();
  const result = await f.setup();
  assert.deepEqual(result.config.workspaces, { project: f.home });
  assert.equal(result.config.restrictToWorkspaces, false);
  assert(f.logs.some((text) => text.includes('当前账户可访问的任意目录')));
});

test('discarding aliases cannot silently widen an existing directory restriction', async (t) => {
  const f = await fixture(t, {
    answer: (prompt) => (prompt.startsWith('保留现有工作区别名') ? 'n' : ''),
  });
  await f.seed();
  const before = await readFile(join(f.configDir, 'telegram.json'), 'utf8');
  await assert.rejects(f.setup(), /保留目录限制需要保留工作区别名/);
  assert.equal(await readFile(join(f.configDir, 'telegram.json'), 'utf8'), before);
});

test('refuses webhook or insufficient topic permissions before writing config', async (t) => {
  for (const [method, value, message] of [
    ['getWebhookInfo', { url: 'https://example.invalid/hook' }, /webhook/],
    ['getChatMember', { status: 'administrator', can_manage_topics: false }, /管理话题/],
  ]) {
    const f = await fixture(t, { api: (name) => (name === method ? value : undefined) });
    await assert.rejects(f.setup(), message);
    await assert.rejects(stat(f.configDir), { code: 'ENOENT' });
    assert(f.calls.every(([, args]) => !args.includes('enable')));
  }
});

test('failed activation restores old files and resumes an existing relay without stopping Pi', async (t) => {
  const f = await fixture(t, {
    active: true,
    execute: (cmd, args) =>
      cmd === 'systemctl' && args[2] === 'enable'
        ? { code: 1, stderr: 'activation failed ' + token }
        : undefined,
  });
  await f.seed();
  const before = await readFile(join(f.configDir, 'telegram.json'), 'utf8');
  await assert.rejects(
    f.setup(),
    (error) => error.message.includes('activation failed') && !error.message.includes(token),
  );
  assert.equal(await readFile(join(f.configDir, 'telegram.json'), 'utf8'), before);
  assert.equal(
    await readFile(join(f.unitDir, 'pi-telegram.service'), 'utf8'),
    'old telegram unit\n',
  );
  assert(f.calls.some(([, args]) => args[2] === 'start' && args.includes('pi-telegram.service')));
  assert(!f.calls.some(([, args]) => args[2] === 'stop' && args.includes('pi-sessions.service')));
});

test('failed first install removes newly written config and stops only its new session daemon', async (t) => {
  const f = await fixture(t, {
    newSessions: true,
    execute: (cmd, args) =>
      cmd === 'systemctl' && args[2] === 'enable'
        ? { code: 1, stderr: 'activation failed' }
        : undefined,
  });
  await assert.rejects(f.setup(), /activation failed/);
  assert.deepEqual(await readdir(f.configDir), []);
  assert.deepEqual(await readdir(f.unitDir), []);
  assert(f.calls.some(([, args]) => args[2] === 'stop' && args.includes('pi-sessions.service')));
  assert(f.calls.some(([, args]) => args[2] === 'disable'));
});

test('declining configuration after re-pairing resumes the relay and preserves every old file', async (t) => {
  const f = await fixture(t, {
    active: true,
    answer: (prompt) => (prompt.startsWith('沿用群组') || prompt.startsWith('应用配置') ? 'n' : ''),
  });
  await f.seed();
  const before = await readFile(join(f.configDir, 'telegram.json'), 'utf8');
  await assert.rejects(f.setup(), /已取消/);
  assert.equal(await readFile(join(f.configDir, 'telegram.json'), 'utf8'), before);
  assert(f.calls.some(([, args]) => args[2] === 'start' && args.includes('pi-telegram.service')));
});

test('linger denial is reported truthfully without sudo or undoing a healthy relay', async (t) => {
  const f = await fixture(t, {
    execute: (cmd) =>
      cmd === 'loginctl' ? { code: 1, stdout: '', stderr: 'policy denied' } : undefined,
  });
  const result = await f.setup();
  assert.equal(result.linger, false);
  assert(f.logs.some((text) => text.includes('尚未保证')));
  assert(f.calls.every(([cmd]) => cmd !== 'sudo'));
});

test('ignores private-chat and anonymous pairing messages before accepting a personal Topics message', async (t) => {
  let polls = 0;
  const f = await fixture(t, {
    api: (method, params, code) => {
      if (method !== 'getUpdates' || params.timeout === 0 || ++polls > 1) return;
      return [
        {
          update_id: 1,
          message: { text: code, from: { id: 99 }, chat: { id: 99, type: 'private' } },
        },
        {
          update_id: 2,
          message: {
            text: code,
            from: { id: 99 },
            sender_chat: { id: -100111 },
            chat: { id: -100111, type: 'supergroup', is_forum: true },
          },
        },
      ];
    },
  });
  assert.deepEqual((await f.setup()).config.allowedUserIds, [42]);
  assert(f.logs.some((text) => text.includes('个人身份')));
});

test('API transport keeps token out of argv, preserves proxy support and redacts failures', async () => {
  const calls = [];
  const api = botApi(token, async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: JSON.stringify({ ok: true, result: bot }) };
  });
  assert.deepEqual(await api('getMe'), bot);
  assert(!calls[0].args.join(' ').includes(token));
  assert(calls[0].options.input.includes(token));
  assert.equal(calls[0].args[0], '--disable');
  const failed = botApi(token, async () => ({
    code: 1,
    stderr: `https://api.telegram.org/bot${token}/getMe via https://user:password@proxy.invalid`,
  }));
  await assert.rejects(
    failed('getMe'),
    (error) => !error.message.includes(token) && !error.message.includes('password'),
  );
});

test('locates services through symlinks and quotes Unicode, spaces and systemd specifiers', async (t) => {
  const f = await fixture(t);
  const current = join(f.home, 'current');
  await symlink(f.serviceDir, current);
  assert.equal(await findServiceDir([join(f.home, 'missing'), current]), f.serviceDir);
  const unit = serviceUnit(f.serviceDir, f.configDir, 'telegram');
  assert(unit.includes('100%% $release/pi-acp-telegram-daemon"'));
  assert(unit.includes(`EnvironmentFile=${f.configDir}/telegram.env`));
  assert(!unit.includes('/home/mkh'));
  assert.throws(() => serviceUnit('/bad\npath', f.configDir, 'telegram'), /换行/);
});

test('hides input before showing the prompt, handles paste/backspace and restores terminal mode', async () => {
  const input = Object.assign(new EventEmitter(), {
    isRaw: false,
    setRawMode(value) {
      this.isRaw = value;
    },
    pause() {},
    resume() {},
  });
  let output = '';
  const stream = {
    write(text) {
      output += text;
      if (text !== '\n') {
        assert.equal(input.isRaw, true);
        input.emit('data', Buffer.from(token + 'x\x7f\r'));
      }
    },
  };
  assert.equal(await readSecret('Token: ', input, stream), token);
  assert.equal(output, 'Token: \n');
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('data'), 0);
  await assert.rejects(
    readSecret('Token: ', input, {
      write(text) {
        if (text !== '\n') input.emit('data', Buffer.from('\x03'));
      },
    }),
    /已取消/,
  );
  assert.equal(input.isRaw, false);
});

test('generated units pass the real systemd parser for Unicode, spaces, percent and dollar paths', async (t) => {
  const f = await fixture(t, { newSessions: true });
  await f.setup();
  const result = await run('systemd-analyze', [
    'verify',
    '--man=no',
    join(f.unitDir, 'pi-telegram.service'),
    join(f.unitDir, 'pi-sessions.service'),
  ]);
  assert.equal(result.code, 0, result.stderr);
});
