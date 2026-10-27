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
/** Build adapter bundles; tests pass a temporary outdir so they never rewrite dist/. */
export async function buildAdapter({ outdir = 'dist' } = {}) {
  // Pin upstream and fail closed if its integration seam changes; keep our implementation in src/.
  const entry = resolve('node_modules/pi-acp/dist/index.js');
  let source = await readFile(entry, 'utf8');
  source = source.replace(/^#![^\n]*\n/, '');
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
      '\n    if (params.workbenchMetadata) args.push("--offline", "--no-approve", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files");' +
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
    '    if (configId.startsWith("context-window:")) {\n      const value = params.value === "default" ? null : Number(params.value);\n      await refreshPiModels(session.proc, {model: configId.slice(15), contextWindow: value});\n      await session.publishContextUsage();\n    } else if (configId === "fast-mode") {\n      await setFastConfig(session.proc, params.value);\n      const record = this.store.get(session.sessionId);\n      if (record) this.store.upsert({...record, workbenchFastMode: params.value});\n    } else if (configId === MODEL_CONFIG_ID) {',
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
    '    if (!name || name === "workbench-fast" || name === "workbench-context") continue;',
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
  source = replaceExactlyOnce(
    source,
    '    const method = stringProp(ev, "method");',
    '    const method = stringProp(ev, "method");\n    const todoPlan = todoWidgetPlan(ev);\n    if (todoPlan) { this.emit(todoPlan); return; }',
  );
  source =
    `import {todoWidgetPlan} from ${JSON.stringify(resolve('src/pi-todo-widget.ts'))};\n` + source;
  const inputStart = source.indexOf('    if (method === "input" || method === "editor") {');
  const inputEnd = source.indexOf('    if (method === "notify") {', inputStart);
  if (inputStart < 0 || inputEnd < inputStart)
    throw new Error('pi-acp integration seam changed: extension input');
  source = replaceExactlyOnce(
    source,
    source.slice(inputStart, inputEnd),
    '    if (method === "input" || method === "editor") {\n      await handleExtensionInput(this, ev, id);\n      return;\n    }\n',
  );
  source =
    `import {handleExtensionInput} from ${JSON.stringify(resolve('src/pi-extension-input.ts'))};\n` +
    source;
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
    '  async prompt(params) {\n    const session = await this.restoreSession(params.sessionId);',
    '  async prompt(params, workbenchCancelled = () => false) {\n    const session = await this.restoreSession(params.sessionId);\n    if (workbenchCancelled()) return {stopReason: "cancelled"};',
  );
  source = replaceExactlyOnce(
    source,
    '    const result = await session.prompt(message, images);',
    '    const result = await session.prompt(message, images, workbenchCancelled);',
  );
  source = replaceExactlyOnce(
    source,
    '  async prompt(message, images = []) {\n    const expandedMessage = expandSlashCommand(message, this.fileCommands);',
    '  async prompt(message, images = [], workbenchCancelled = () => false) {\n    const expandedMessage = expandSlashCommand(message, this.fileCommands);',
  );
  source = replaceExactlyOnce(
    source,
    '      const queued = { message: expandedMessage, images, resolve: resolve4, reject };',
    '      const queued = { message: expandedMessage, images, resolve: resolve4, reject, workbenchCancelled };',
  );
  source = replaceExactlyOnce(
    source,
    '  startTurn(t) {\n    this.cancelRequested = false;',
    `  startTurn(t) {
    while (t.workbenchCancelled?.()) {
      t.resolve("cancelled");
      t = this.turnQueue.shift();
      if (!t) return;
    }
    this.cancelRequested = false;
    this.modelError = undefined;`,
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
      `sessionUpdate: "${kind}",\n            messageId: piMessageId(this),\n            content: { type: "text", text: ame.delta }`,
    );
  }
  source = replaceExactlyOnce(
    source,
    '  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) return null;',
    '  if (used === null && Number.isSafeInteger(size) && size > 0) return { sessionUpdate: "session_info_update", _meta: { "pi-workbench-context": { used: null, size } } };\n  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) return null;',
  );
  source = replaceExactlyOnce(
    source,
    '    this.proc.prompt(t.message, t.images).catch((err) => {',
    '    const ownedTurn = this.pendingTurn;\n    this.proc.prompt(t.message, t.images).catch((err) => {\n      if (this.pendingTurn !== ownedTurn) return;',
  );
  source = replaceExactlyOnce(
    source,
    '    await this.proc.abort();',
    '    await cancelPiRun(this);',
  );
  source = replaceExactlyOnce(
    source,
    '  async requestExtensionPermission(id, ev, options) {\n    try {',
    '  async requestExtensionPermission(id, ev, options) {\n    await this.flushEmits();\n    try {',
  );
  source = replaceExactlyOnce(
    source,
    '  emit(update) {\n    this.lastEmit = this.lastEmit.then(',
    '  emit(update) {\n    update = piLiveUpdate(this, update);\n    this.lastEmit = this.lastEmit.then(',
  );
  source = replaceExactlyOnce(
    source,
    '      if (this.pendingTurn) {',
    '      if (piRunBusy(this)) {',
  );
  const queueStart = source.indexOf('      if (piRunBusy(this)) {');
  const queueEnd = source.indexOf('      this.startTurn(queued);', queueStart);
  if (queueStart < 0 || queueEnd < queueStart)
    throw new Error('pi-acp integration seam changed: prompt queue');
  source = replaceExactlyOnce(
    source,
    source.slice(queueStart, queueEnd),
    '      if (piRunBusy(this)) {\n        reject(RequestError3.internalError({}, "发送失败：Agent 正在工作，消息未发送，请稍后重试。"));\n        return;\n      }\n',
  );
  const promptCatchStart = source.indexOf(
    '      void this.flushEmits().finally(() => {',
    source.indexOf('    const ownedTurn = this.pendingTurn;'),
  );
  const promptCatchEnd =
    source.indexOf('      void err;', promptCatchStart) + '      void err;'.length;
  if (promptCatchStart < 0 || promptCatchEnd < promptCatchStart)
    throw new Error('pi-acp integration seam changed: prompt rejection');
  source = replaceExactlyOnce(
    source,
    source.slice(promptCatchStart, promptCatchEnd),
    '      rejectPiPrompt(this, ownedTurn, err, message => maybeAuthRequiredError(err) || RequestError3.internalError({}, message));',
  );
  source = replaceExactlyOnce(
    source,
    '    switch (type) {',
    '    if (handlePiRunEvent(this, ev)) return;\n    switch (type) {',
  );
  source = replaceExactlyOnce(
    source,
    '  async publishContextUsage() {',
    '  async publishContextUsage(workbenchRun) {',
  );
  source = replaceExactlyOnce(
    source,
    '        if (update) this.emit(update);',
    '        if (update) this.emit(workbenchRun ? {...update, _meta: {...update._meta, "pi-workbench-live": workbenchRun}} : update);',
  );
  const settleStart = source.indexOf('  async settleTurn() {');
  const settleEnd = source.indexOf('  emitBashToolCall(params)', settleStart);
  if (settleStart < 0 || settleEnd < settleStart)
    throw new Error('pi-acp integration seam changed: settleTurn');
  source = replaceExactlyOnce(
    source,
    source.slice(settleStart, settleEnd),
    `  async settleTurn() {
    await settlePiRun(this, message => RequestError3.internalError({}, message));
  }
`,
  );

  source = replaceExactlyOnce(
    source,
    '  eventHandlers = [];',
    '  eventHandlers = [];\n  workbenchBacklog = new PiEventBacklog();\n  workbenchStartupError;',
  );
  source = replaceExactlyOnce(
    source,
    '      for (const h of this.eventHandlers) h(msg);',
    `      if (!this.eventHandlers.length) {
        try { this.workbenchBacklog.push(msg); }
        catch (error) {
          this.workbenchStartupError = error;
          for (const [, pending] of this.pending) pending.reject(error);
          this.pending.clear();
          this.dispose();
        }
        return;
      }
      for (const h of this.eventHandlers) h(msg);`,
  );
  source = replaceExactlyOnce(
    source,
    '  onEvent(handler) {\n    this.eventHandlers.push(handler);',
    '  onEvent(handler) {\n    if (this.workbenchStartupError) throw this.workbenchStartupError;\n    this.eventHandlers.push(handler);\n    this.workbenchBacklog.drain(handler);',
  );
  source = source.replace(/^#!.*\n/, '');

  source =
    `import {PiEventBacklog} from ${JSON.stringify(resolve('src/pi-event-backlog.ts'))};\n` +
    `import {piRunBusy, handlePiRunEvent, settlePiRun, piMessageId, piLiveUpdate, cancelPiRun, rejectPiPrompt} from ${JSON.stringify(resolve('src/pi-session-runs.ts'))};\n` +
    `import {resolvePiCommand} from ${JSON.stringify(resolve('src/pi-command.ts'))};\n` +
    source;
  source =
    `import {fastConfig, setFastConfig, restoreEmptyFastConfig} from ${JSON.stringify(resolve('src/pi-fast-config.ts'))};
import {fileURLToPath as workbenchFileURLToPath} from 'node:url';
const workbenchFastExtension = workbenchFileURLToPath(new URL('./pi-fast-mode.mjs', import.meta.url));
async function getWorkbenchFastOptions(proc) { const config = await fastConfig(proc); return config ? [config] : []; }
` + source;

  source =
    `import {refreshPiModels} from ${JSON.stringify(resolve('src/pi-context-config.ts'))};\n` +
    source;
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
    outfile: resolve(outdir, 'pi-adapter.mjs'),
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
    outfile: resolve(outdir, 'pi-fast-mode.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import {createRequire as workbenchCreateRequire} from "node:module"; const require = workbenchCreateRequire(import.meta.url);',
    },
    sourcemap: true,
  });
  await build({
    entryPoints: ['src/pi-native-fork.ts'],
    outfile: resolve(outdir, 'pi-native-fork.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
  });
}
