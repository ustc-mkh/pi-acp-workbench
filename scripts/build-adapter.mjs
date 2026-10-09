import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
export function replaceExactlyOnce(source, target, replacement) {
  if (source.split(target).length !== 2)
    throw new Error(`pi-acp integration seam changed: ${target}`);
  return source.replace(target, () => replacement);
}
export function assertRequestErrorBinding(source) {
  if (
    !/import\s*\{[^}]*\bRequestError\s+as\s+RequestError3\b[^}]*\}\s*from\s*["']@agentclientprotocol\/sdk["']/.test(
      source,
    )
  )
    throw new Error('pi-acp integration seam changed: RequestError3 import binding');
}
export async function buildAdapter() {
  // Pin upstream and fail closed if its integration seam changes; keep our implementation in src/.
  const entry = resolve('node_modules/pi-acp/dist/index.js');
  let source = await readFile(entry, 'utf8');
  assertRequestErrorBinding(source);
  source = replaceExactlyOnce(
    source,
    'return override ?? defaultPiCommand();',
    'return resolvePiCommand(override);',
  );
  source = replaceExactlyOnce(
    source,
    'const cmd = getPiCommand(params.piCommand);',
    'const cmd = await resolvePiCommand(params.piCommand, params.cwd);',
  );
  source = replaceExactlyOnce(
    source,
    'const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND);',
    'const cmd = await getPiCommand(process.env.PI_ACP_PI_COMMAND);',
  );
  const factory = 'new PiAcpAgent(conn)',
    args = 'const args = ["--mode", "rpc", "--no-themes"];';
  source = replaceExactlyOnce(
    source,
    factory,
    'new (enhancePiAgent(PiAcpAgent, PiRpcProcess, RequestError3))(conn)',
  );
  source = replaceExactlyOnce(
    source,
    args,
    args +
      '\n    args.push("--extension", workbenchFastExtension);\n    if (params.workbenchFork) args.push("--no-extensions", "--extension", params.workbenchFork, "--session-dir", params.workbenchForkSessionDir);',
  );
  source = replaceExactlyOnce(
    source,
    '    configOptions: buildConfigOptions({ models, modes }),',
    '    configOptions: [...buildConfigOptions({ models, modes }), ...await getWorkbenchFastOptions(proc)],',
  );
  source = replaceExactlyOnce(
    source,
    '    if (configId === MODEL_CONFIG_ID) {',
    '    if (configId === "fast-mode") {\n      await setFastConfig(session.proc, params.value);\n      const record = this.store.get(session.sessionId);\n      if (record) this.store.upsert({...record, workbenchFastMode: params.value});\n    } else if (configId === MODEL_CONFIG_ID) {',
  );
  source = replaceExactlyOnce(
    source,
    '      await setSessionModel(session.proc, params.value);',
    `      const previous = await session.proc.getState();
      const fast = await getWorkbenchFastOptions(session.proc);
      await setSessionModel(session.proc, params.value);
      const levels = await session.proc.getAvailableThinkingLevels();
      if (typeof previous.thinkingLevel === "string" && levels.includes(previous.thinkingLevel))
        await session.proc.setThinkingLevel(previous.thinkingLevel);
      const currentFast = await getWorkbenchFastOptions(session.proc);
      if (fast[0] && currentFast[0] && fast[0].currentValue !== currentFast[0].currentValue)
        await setFastConfig(session.proc, fast[0].currentValue);`,
  );
  source = replaceExactlyOnce(
    source,
    '    db.sessions[entry.sessionId] = {\n      sessionId: entry.sessionId,',
    '    db.sessions[entry.sessionId] = {\n      ...db.sessions[entry.sessionId],\n      ...entry,\n      sessionId: entry.sessionId,',
  );
  source = replaceExactlyOnce(
    source,
    '      const fileCommands = loadSlashCommands(cwd);',
    '      try { await restoreEmptyFastConfig(proc, this.store.get(sessionId)?.workbenchFastMode); } catch (error) { proc.dispose(); throw error; }\n      const fileCommands = loadSlashCommands(cwd);',
  );
  source = replaceExactlyOnce(
    source,
    '    if (!name) continue;',
    '    if (!name || name === "workbench-fast") continue;',
  );
  source = replaceExactlyOnce(
    source,
    'return join(homedir(), ".pi", "pi-acp");',
    'return process.env.PI_ACP_WORKBENCH_STATE_DIR || join(homedir(), ".pi", "pi-acp");',
  );
  source = replaceExactlyOnce(
    source,
    'const updateNotice = buildUpdateNotice();',
    'const updateNotice = null;',
  );
  source = replaceExactlyOnce(
    source,
    'const timeoutMs = opts?.timeoutMs;',
    'const timeoutMs = opts?.timeoutMs ?? (cmd.type === "compact" ? undefined : 30000);',
  );
  const compactStart = source.indexOf('      if (cmd === "compact") {');
  const compactEnd = source.indexOf('      if (cmd === "session") {', compactStart);
  if (compactStart < 0 || compactEnd < compactStart)
    throw new Error('pi-acp integration seam changed: compact command');
  source = replaceExactlyOnce(
    source,
    source.slice(compactStart, compactEnd),
    `      if (cmd === "compact") {
        const customInstructions = args.join(" ").trim() || undefined;
        await session.proc.compact(customInstructions);
        await session.publishContextUsage();
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "上下文压缩成功。" } }
        });
        return { stopReason: "end_turn" };
      }
`,
  );
  // Upstream treats exhausted model retries as a successful end_turn. Preserve the final failure.
  source = replaceExactlyOnce(
    source,
    '  cancelRequested = false;',
    '  cancelRequested = false;\n  modelError = undefined;',
  );
  source = replaceExactlyOnce(
    source,
    '  startTurn(t) {\n    this.cancelRequested = false;',
    '  startTurn(t) {\n    this.cancelRequested = false;\n    this.modelError = undefined;',
  );
  source = replaceExactlyOnce(
    source,
    '      case "turn_end": {',
    `      case "message_end": {
        if (ev.message?.role === "assistant") this.modelError = ev.message.stopReason === "error" ? providerError(ev.message.errorMessage) : undefined;
        break;
      }
      case "turn_end": {`,
  );
  source = replaceExactlyOnce(
    source,
    '    this.pendingTurn?.resolve(reason);\n    this.pendingTurn = null;',
    '    if (this.modelError && !this.cancelRequested) this.pendingTurn?.reject(RequestError3.internalError({}, this.modelError));\n    else this.pendingTurn?.resolve(reason);\n    this.pendingTurn = null;',
  );
  source = replaceExactlyOnce(
    source,
    'text: "Retry finished, resuming."',
    'text: ev.success === false ? "\\n重试已耗尽，模型请求失败。" : "\\n重试结束。"',
  );
  // Several Telegram sessions and VS Code windows may update the native registry together.
  source = replaceExactlyOnce(
    source,
    '  upsert(entry) {\n    const db = loadFile(this.path);',
    '  upsert(entry) {\n    return mutateAdapterStore(this.path, db => {',
  );
  source = replaceExactlyOnce(
    source,
    '    saveFile(this.path, db);\n  }\n  delete(sessionId)',
    '    });\n  }\n  delete(sessionId)',
  );
  source = replaceExactlyOnce(
    source,
    '  delete(sessionId) {\n    const db = loadFile(this.path);',
    '  delete(sessionId) {\n    return mutateAdapterStore(this.path, db => {',
  );
  source = replaceExactlyOnce(
    source,
    '    delete db.sessions[sessionId];\n    saveFile(this.path, db);',
    '    delete db.sessions[sessionId];\n    });',
  );
  for (const kind of ['agent_message_chunk', 'agent_thought_chunk']) {
    const target = `sessionUpdate: "${kind}",\n            content: { type: "text", text: ame.delta }`;
    source = replaceExactlyOnce(
      source,
      target,
      `sessionUpdate: "${kind}",\n            messageId: typeof ame.partial?.timestamp === "number" ? String(ame.partial.timestamp) : undefined,\n            content: { type: "text", text: ame.delta }`,
    );
  }
  source = replaceExactlyOnce(
    source,
    '  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) return null;',
    '  if (used === null && Number.isSafeInteger(size) && size > 0) return { sessionUpdate: "session_info_update", _meta: { "pi-workbench-context": { used: null, size } } };\n  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) return null;',
  );
  source = source.replace(/^#!.*\n/, '');

  source =
    `import {resolvePiCommand} from ${JSON.stringify(resolve('src/pi-command.ts'))};\n` + source;
  source =
    `import {fastConfig, setFastConfig, restoreEmptyFastConfig} from ${JSON.stringify(resolve('src/pi-fast-config.ts'))};
import {fileURLToPath as workbenchFileURLToPath} from 'node:url';
const workbenchFastExtension = workbenchFileURLToPath(new URL('./pi-fast-mode.mjs', import.meta.url));
async function getWorkbenchFastOptions(proc) { const config = await fastConfig(proc); return config ? [config] : []; }
` + source;

  source =
    `import {enhancePiAgent} from ${JSON.stringify(resolve('src/pi-enhancements.ts'))};\n` + source;
  source =
    `import {mutateAdapterStore} from ${JSON.stringify(resolve('src/adapter-store.ts'))};\n` +
    source;
  source =
    `import {providerError} from ${JSON.stringify(resolve('src/adapter-errors.ts'))};\n` + source;
  await build({
    stdin: {
      contents: source,
      resolveDir: resolve('node_modules/pi-acp/dist'),
      sourcefile: 'pi-acp-workbench-adapter.mjs',
    },
    outfile: 'dist/pi-adapter.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    banner: {
      js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
    },
  });
  await build({
    entryPoints: ['src/pi-fast-mode.ts'],
    outfile: 'dist/pi-fast-mode.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
  });
  await build({
    entryPoints: ['src/pi-native-fork.ts'],
    outfile: 'dist/pi-native-fork.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
  });
}
