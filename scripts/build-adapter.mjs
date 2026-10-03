import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
export function replaceExactlyOnce(source, target, replacement) {
  if (source.split(target).length !== 2) throw new Error(`pi-acp integration seam changed: ${target}`);
  return source.replace(target, () => replacement);
}
export async function buildAdapter() {
  // Pin upstream and fail closed if its integration seam changes; keep our implementation in src/.
  const entry=resolve('node_modules/pi-acp/dist/index.js');
  let source=await readFile(entry,'utf8');
  const factory='new PiAcpAgent(conn)', args='const args = ["--mode", "rpc", "--no-themes"];';
  source=replaceExactlyOnce(source,factory,'new (enhancePiAgent(PiAcpAgent, PiRpcProcess))(conn)');
  source=replaceExactlyOnce(source,args,args+'\n    if (params.workbenchFork) args.push("--no-extensions", "--extension", params.workbenchFork, "--session-dir", params.workbenchForkSessionDir);\n    if (params.workbenchSummary) args.push("--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--system-prompt", "You summarize historical conversation data. You have no tools. Return only a concise factual summary.");');
  source=replaceExactlyOnce(source,'return join(homedir(), ".pi", "pi-acp");','return process.env.PI_ACP_WORKBENCH_STATE_DIR || join(homedir(), ".pi", "pi-acp");');
  source=replaceExactlyOnce(source,'const updateNotice = buildUpdateNotice();','const updateNotice = null;');
  source=replaceExactlyOnce(source,'const timeoutMs = opts?.timeoutMs;', 'const timeoutMs = opts?.timeoutMs ?? 30000;');
  for (const kind of ['agent_message_chunk','agent_thought_chunk']) {
    const target=`sessionUpdate: "${kind}",\n            content: { type: "text", text: ame.delta }`;
    source=replaceExactlyOnce(source,target,`sessionUpdate: "${kind}",\n            messageId: typeof ame.partial?.timestamp === "number" ? String(ame.partial.timestamp) : undefined,\n            content: { type: "text", text: ame.delta }`);
  }
  source=source.replace(/^#!.*\n/,'');
  source=`import {enhancePiAgent} from ${JSON.stringify(resolve('src/pi-enhancements.ts'))};\n`+source;
  await build({stdin:{contents:source,resolveDir:resolve('node_modules/pi-acp/dist'),sourcefile:'pi-acp-workbench-adapter.mjs'},outfile:'dist/pi-adapter.mjs',bundle:true,platform:'node',format:'esm',target:'node20',sourcemap:true,
    banner:{js:'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);'}});
  await build({entryPoints:['src/pi-native-fork.ts'],outfile:'dist/pi-native-fork.mjs',bundle:true,platform:'node',format:'esm',target:'node20',sourcemap:true});
}
