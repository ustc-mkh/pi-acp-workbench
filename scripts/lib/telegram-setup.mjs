import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';

export function readSecret(prompt, input = process.stdin, output = process.stdout) {
  const wasRaw = input.isRaw;
  return new Promise((done, reject) => {
    let value = '';
    const finish = (error) => {
      input.off('data', read);
      input.setRawMode(!!wasRaw);
      input.pause();
      output.write('\n');
      error ? reject(error) : done(value);
    };
    const read = (chunk) => {
      for (const c of chunk.toString()) {
        if (c === '\r' || c === '\n') {
          finish();
          return;
        }
        if (c === '\x03' || c === '\x04') {
          finish(new Error('已取消'));
          return;
        }
        if (c === '\x7f' || c === '\b') value = value.slice(0, -1);
        else if (/^[A-Za-z0-9:_-]$/.test(c)) value += c;
      }
    };
    input.setRawMode(true);
    input.on('data', read);
    input.resume();
    output.write(prompt);
  });
}

export function redact(text, token = '') {
  return String(text)
    .replaceAll(token || '\0', '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
}

/** No shell, and secrets go through stdin rather than process arguments. */
export function run(command, args, { input, timeout = 45000 } = {}) {
  return new Promise((done, reject) => {
    const env = { ...process.env, SYSTEMD_PAGER: 'cat', SYSTEMD_COLORS: '0' };
    delete env.PI_TELEGRAM_BOT_TOKEN;
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '',
      failure;
    const timer = setTimeout(() => {
      failure = new Error(`${command} 超时`);
      child.kill('SIGKILL');
    }, timeout);
    for (const [stream, name] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ]) {
      stream.on('data', (chunk) => {
        if (name === 'stdout') stdout += chunk;
        else stderr += chunk;
        if (stdout.length + stderr.length > 4 * 1024 * 1024) {
          failure = new Error(`${command} 响应过大`);
          child.kill('SIGKILL');
        }
      });
    }
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      failure ? reject(failure) : done({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function botApi(token, execute = run) {
  return async (method, params = {}) => {
    if (!/^[a-zA-Z]+$/.test(method)) throw new Error('无效 Bot API 方法');
    // curl honours HTTPS_PROXY/ALL_PROXY, unlike Node 22's default fetch.
    const result = await execute(
      'curl',
      [
        '--disable',
        '--silent',
        '--show-error',
        '--max-time',
        '35',
        '--proto',
        '=https',
        '--request',
        'POST',
        '--header',
        'Content-Type: application/json',
        '--config',
        '-',
      ],
      {
        input: `url = ${JSON.stringify(`https://api.telegram.org/bot${token}/${method}`)}\ndata = ${JSON.stringify(JSON.stringify(params))}\n`,
      },
    );
    if (result.code !== 0)
      throw new Error(redact(`Telegram 网络连接失败：${result.stderr}`, token));
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      throw new Error('Telegram 返回了无效响应，请检查网络或代理');
    }
    if (!response.ok)
      throw new Error(
        redact(
          `Telegram ${method}：${response.description || response.error_code || '请求失败'}`,
          token,
        ),
      );
    return response.result;
  };
}

export async function findServiceDir(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(join(candidate, 'pi-acp-telegram-daemon'), constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error(
    '未找到 Telegram 服务程序。请解压服务发布包后运行，或先执行 npm run build:services；也可传 --service-dir 指定产物目录。',
  );
}

function unitQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('路径或环境变量不能包含换行或 NUL');
  return '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

export function serviceUnit(serviceDir, configDir, kind, path = process.env.PATH || '') {
  const telegram = kind === 'telegram';
  const execQuote = (value) => unitQuote(value.replaceAll('$', () => '$$'));
  return `[Unit]\nDescription=Pi ACP Workbench ${kind}\nAfter=network-online.target${telegram ? ' pi-sessions.service' : ''}\nWants=network-online.target${telegram ? ' pi-sessions.service' : ''}\n\n[Service]\nType=simple\nWorkingDirectory=${serviceDir.replaceAll('%', '%%')}\n${telegram ? `EnvironmentFile=${join(configDir, 'telegram.env').replaceAll('%', '%%')}` : `Environment=${unitQuote('PATH=' + path)}`}\nExecStart=${unitQuote(join(serviceDir, `pi-acp-${telegram ? 'telegram' : 'session'}-daemon`))} --config ${execQuote(join(configDir, `${telegram ? 'telegram' : 'sessions'}.json`))}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=45\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

async function readOptional(file) {
  try {
    if (!(await lstat(file)).isFile()) throw new Error(`配置路径必须是普通文件：${file}`);
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function atomicWrite(file, text) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const yes = (value) => value.trim() === '' || /^(y|yes|是)$/i.test(value.trim());
const clean = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

async function pair(api, username, log) {
  const code = '/setup_' + randomBytes(6).toString('hex');
  log(
    `请先建立私人 Topics 群组，将 @${username} 设为管理员并允许管理话题。\n在该群组中，用你的个人身份发送：\n\n  ${code}@${username}\n\n等待配对（最多 3 分钟）…`,
  );
  let offset;
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const updates = await api('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] });
    if (!Array.isArray(updates)) throw new Error('Telegram updates 格式无效');
    for (const update of updates) {
      if (Number.isSafeInteger(update.update_id))
        offset = Math.max(offset || 0, update.update_id + 1);
      const m = update.message;
      if (![code, `${code}@${username}`].includes(m?.text?.trim())) continue;
      if (m.chat?.type !== 'supergroup' || !m.chat.is_forum) {
        log('该消息不在 Topics 超级群组中，请开启群组话题后重新发送配对码。');
        continue;
      }
      if (m.sender_chat || m.from?.is_bot || !Number.isSafeInteger(m.from?.id) || m.from.id <= 0) {
        log('请关闭匿名管理员发言，用个人身份重新发送配对码。');
        continue;
      }
      // Consume the setup command so an existing relay never forwards it as a model prompt.
      await api('getUpdates', {
        offset: update.update_id + 1,
        timeout: 0,
        allowed_updates: ['message'],
      });
      return { chatId: m.chat.id, allowedUserIds: [m.from.id] };
    }
  }
  throw new Error('配对超时。请检查群组话题、Bot 管理员权限和网络后重试。');
}

/** Dependency injection keeps setup tests offline and away from the user's services. */
export async function configureTelegram({
  serviceDir,
  ask,
  secret,
  log = console.log,
  execute = run,
  apiFactory = botApi,
  home = homedir(),
  configHome = process.env.XDG_CONFIG_HOME || join(home, '.config'),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  signal,
}) {
  const configDir = join(configHome, 'pi-acp-workbench');
  const unitDir = join(configHome, 'systemd/user');
  const jsonFile = join(configDir, 'telegram.json');
  const envFile = join(configDir, 'telegram.env');
  const unitFile = join(unitDir, 'pi-telegram.service');
  const system = async (...args) => execute('systemctl', ['--user', '--no-ask-password', ...args]);
  const must = async (...args) => {
    const result = await system(...args);
    if (result.code !== 0) throw new Error(result.stderr || `systemctl ${args.join(' ')} 失败`);
    return result.stdout;
  };
  await must('show-environment');
  if ((await execute('curl', ['--version'])).code !== 0) throw new Error('需要系统已有的 curl');
  const oldJson = await readOptional(jsonFile);
  const oldEnv = await readOptional(envFile);
  const current = oldJson === undefined ? undefined : JSON.parse(oldJson);
  const savedToken = oldEnv?.match(/^PI_TELEGRAM_BOT_TOKEN=(\d+:[A-Za-z0-9_-]{20,})\s*$/m)?.[1];
  const token =
    savedToken && yes(await ask('已保存 Bot token，沿用？[Y/n] '))
      ? savedToken
      : (await secret('Bot token（输入隐藏）：')).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Bot token 格式无效');
  const request = apiFactory(token, execute);
  const api = async (...args) => {
    signal?.throwIfAborted();
    const result = await request(...args);
    signal?.throwIfAborted();
    return result;
  };
  const bot = await api('getMe');
  if (!bot.is_bot || !Number.isSafeInteger(bot.id) || !/^[A-Za-z0-9_]+$/.test(bot.username))
    throw new Error('Bot 身份响应无效');
  log(`已验证 Bot：@${bot.username}`);
  if ((await api('getWebhookInfo')).url)
    throw new Error('该 Bot 已配置 webhook。请使用专用 Bot 或先停用其 webhook，再重新配置。');
  const relayState = (await system('is-active', 'pi-telegram.service')).stdout;
  const wasActive = ['active', 'activating'].includes(relayState);
  let stopped = false,
    written = false,
    createdSessions = false,
    originals,
    backup;
  const wasEnabled = (await system('is-enabled', 'pi-telegram.service')).code === 0;
  try {
    const reuse =
      savedToken === token &&
      current &&
      yes(
        await ask(
          `沿用群组 ${current.chatId} 和授权用户 ${current.allowedUserIds?.join(', ')}？[Y/n] `,
        ),
      );
    let ids;
    if (reuse) ids = { chatId: current.chatId, allowedUserIds: current.allowedUserIds };
    else {
      if (wasActive) {
        await must('stop', 'pi-telegram.service');
        stopped = true;
      }
      ids = await pair(api, bot.username, log);
    }
    if (
      !Number.isSafeInteger(ids.chatId) ||
      ids.chatId >= 0 ||
      !Array.isArray(ids.allowedUserIds) ||
      !ids.allowedUserIds.length ||
      ids.allowedUserIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      throw new Error('群组或授权用户 ID 无效');
    const chat = await api('getChat', { chat_id: ids.chatId });
    if (chat.type !== 'supergroup' || !chat.is_forum) throw new Error('群组必须开启 Topics / 话题');
    const member = await api('getChatMember', { chat_id: ids.chatId, user_id: bot.id });
    if (
      !(
        member.status === 'creator' ||
        (member.status === 'administrator' && member.can_manage_topics)
      )
    )
      throw new Error('请把 Bot 设为群管理员并开启管理话题权限，然后重试');
    let workspaces = {};
    if (
      current?.workspaces &&
      Object.keys(current.workspaces).length &&
      yes(await ask('保留现有工作区别名？[Y/n] '))
    )
      workspaces = { ...current.workspaces };
    const restrictToWorkspaces =
      current?.restrictToWorkspaces === true &&
      yes(await ask('保留现有目录限制（仅允许已配置的目录）？[Y/n] '));
    if (restrictToWorkspaces && !Object.keys(workspaces).length)
      throw new Error('保留目录限制需要保留工作区别名；如需任意目录，请取消目录限制');
    for (const [name, path] of Object.entries(workspaces)) {
      if (
        !/^[A-Za-z0-9_-]+$/.test(name) ||
        ['__proto__', 'constructor', 'prototype'].includes(name) ||
        typeof path !== 'string'
      )
        throw new Error('工作区名称或路径无效');
      workspaces[name] = await realpath(path);
      if (!(await stat(workspaces[name])).isDirectory()) throw new Error(`项目目录无效：${path}`);
    }
    log(
      `\n将连接群组：${clean(chat.title)} (${ids.chatId})\n授权用户：${ids.allowedUserIds.join(', ')}\n目录范围：${restrictToWorkspaces ? Object.values(workspaces).join(', ') : '当前账户可访问的任意目录，创建会话时指定'}\n启用用户级 Telegram 服务与自启动。`,
    );
    if (!yes(await ask('应用配置？[Y/n] '))) throw new Error('已取消，配置未修改');
    signal?.throwIfAborted();
    const config = {
      ...ids,
      workspaces,
      restrictToWorkspaces,
      ...(current?.serviceSocket ? { serviceSocket: current.serviceSocket } : {}),
    };
    if (config.serviceSocket && !config.serviceSocket.startsWith('/'))
      throw new Error('serviceSocket 必须为绝对路径');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
    await mkdir(unitDir, { recursive: true });
    const sessionsUnit = join(unitDir, 'pi-sessions.service');
    const sessionsFile = join(configDir, 'sessions.json');
    const hasSessions =
      (await must('show', 'pi-sessions.service', '-p', 'LoadState', '--value')) !== 'not-found';
    createdSessions = !hasSessions;
    if (!hasSessions) await access(join(serviceDir, 'pi-acp-session-daemon'), constants.X_OK);
    const changes = new Map([
      [jsonFile, JSON.stringify(config, null, 2) + '\n'],
      // A one-shot request consumed by the relay; normal restarts do not sync history.
      [jsonFile + '.sync-request', 'preview\n'],
      [
        envFile,
        `PI_TELEGRAM_BOT_TOKEN=${token}\n` +
          (oldEnv || '').replace(/^PI_TELEGRAM_BOT_TOKEN=.*(?:\r?\n|$)/gm, ''),
      ],
      [unitFile, serviceUnit(serviceDir, configDir, 'telegram')],
    ]);
    for (const name of [
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'https_proxy',
      'http_proxy',
      'all_proxy',
      'no_proxy',
    ]) {
      const value = process.env[name];
      if (value === undefined) continue;
      if (/[\r\n\0]/.test(value)) throw new Error(`${name} 不能包含换行或 NUL`);
      changes.set(
        envFile,
        changes.get(envFile).replace(new RegExp(`^${name}=.*(?:\\r?\\n|$)`, 'gm'), '') +
          `${name}=${JSON.stringify(value)}\n`,
      );
    }
    if (!hasSessions) {
      changes.set(
        sessionsUnit,
        serviceUnit(
          serviceDir,
          configDir,
          'sessions',
          [
            ...new Set(
              [
                dirname(process.execPath),
                join(home, '.local/bin'),
                ...(process.env.PATH || '').split(':'),
              ].filter(Boolean),
            ),
          ].join(':'),
        ),
      );
      if ((await readOptional(sessionsFile)) === undefined) changes.set(sessionsFile, '{}\n');
    }
    originals = new Map();
    for (const file of changes.keys()) originals.set(file, await readOptional(file));
    if ([...originals.values()].some((value) => value !== undefined)) {
      backup = join(
        configDir,
        'backups',
        'telegram-' + Date.now() + '-' + randomBytes(3).toString('hex'),
      );
      await mkdir(backup, { recursive: true, mode: 0o700 });
      for (const [file, content] of originals)
        if (content !== undefined) {
          await copyFile(file, join(backup, basename(file)));
          await chmod(join(backup, basename(file)), 0o600);
        }
      log(`原配置已备份：${backup}`);
    }
    // Stop only the relay. Existing Pi tasks and their daemon are left running.
    if (!stopped && wasActive) {
      await must('stop', 'pi-telegram.service');
      stopped = true;
    }
    written = true;
    for (const [file, content] of changes) await atomicWrite(file, content);
    await must('daemon-reload');
    await must('start', 'pi-sessions.service');
    await must('enable', '--now', 'pi-telegram.service');
    const invocation = await must('show', 'pi-telegram.service', '-p', 'InvocationID', '--value');
    if (!/^[a-f0-9]{32}$/.test(invocation)) throw new Error('未获得 Telegram 服务启动标识');
    let ready = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      signal?.throwIfAborted();
      const status = await system('is-active', 'pi-telegram.service');
      const journal = await execute('journalctl', [
        '--user',
        '-u',
        'pi-telegram.service',
        `_SYSTEMD_INVOCATION_ID=${invocation}`,
        '-n',
        '30',
        '--no-pager',
        '-o',
        'cat',
      ]);
      if (
        status.stdout === 'active' &&
        journal.stdout.includes(`Telegram relay ready: @${bot.username},`)
      ) {
        ready = true;
        break;
      }
      if (['failed', 'activating'].includes(status.stdout))
        throw new Error(redact(journal.stdout || 'Telegram 服务启动失败', token));
      await wait(1000);
    }
    if (!ready)
      throw new Error('未收到 Telegram 就绪日志，请检查 journalctl --user -u pi-telegram');
    log(
      '已请求后台同步：最新 5 个会话各取最后 10 条，其余各取最后 2 条；在会话话题使用 /history 获取更多消息。',
    );
    const user = String(userInfo().uid);
    const login = async (args) => {
      try {
        return await execute('loginctl', args);
      } catch {
        return { code: 1, stdout: '' };
      }
    };
    let linger = await login(['show-user', user, '-p', 'Linger', '--value']);
    if (linger.stdout !== 'yes') {
      await login(['--no-ask-password', 'enable-linger', user]);
      linger = await login(['show-user', user, '-p', 'Linger', '--value']);
    }
    log(
      `\n配置完成。向群组发送 /help，然后 /new ${restrictToWorkspaces ? Object.keys(workspaces)[0] : '/项目的绝对路径'} 开始对话。\n查看日志：journalctl --user -u pi-telegram -f`,
    );
    if (linger.stdout !== 'yes')
      log(
        '已启用登录后自启动；本机策略未允许免管理员启用 linger，退出登录后常驻与未登录时开机启动尚未保证。',
      );
    else log('已启用开机自启动，退出登录后服务继续运行。');
    return { config, backup, linger: linger.stdout === 'yes' };
  } catch (error) {
    if (written) {
      await system('stop', 'pi-telegram.service');
      if (createdSessions) await system('stop', 'pi-sessions.service');
      for (const [file, content] of originals) {
        if (content === undefined) await rm(file, { force: true });
        else await atomicWrite(file, content);
      }
      await system('daemon-reload');
      if (!wasEnabled) await system('disable', 'pi-telegram.service');
    }
    if (stopped && wasActive) await system('start', 'pi-telegram.service');
    throw new Error(redact(error.message, token));
  }
}
