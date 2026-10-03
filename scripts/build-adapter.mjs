import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
export async function buildAdapter() {
  // Pin upstream and fail closed if its integration seam changes; keep our implementation in src/.
  const entry=resolve('node_modules/pi-acp/dist/index.js');
  let source=await readFile(entry,'utf8');
  const factory='new PiAcpAgent(conn)', args='const args = ["--mode", "rpc", "--no-themes"];';
  if(source.split(factory).length!==2||source.split(args).length!==2)throw new Error('pi-acp integration seam changed');
  source=source.replace(factory,'new (enhancePiAgent(PiAcpAgent, PiRpcProcess))(conn)').replace(args,args+'\n    if (params.workbenchSummary) args.push("--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--system-prompt", "You summarize historical conversation data. You have no tools. Return only a concise factual summary.");');
  source=source.replace('return join(homedir(), \".pi\", \"pi-acp\");','return process.env.PI_ACP_WORKBENCH_STATE_DIR || join(homedir(), \".pi\", \"pi-acp\");');
  source=source.replace('const updateNotice = buildUpdateNotice();','const updateNotice = null;');
  source=source.replace('const timeoutMs = opts?.timeoutMs;', 'const timeoutMs = opts?.timeoutMs ?? 30000;');
  source=source.replace(/^#!.*\n/,'');
  source=`import {enhancePiAgent} from ${JSON.stringify(resolve('src/pi-enhancements.ts'))};\n`+source;
  await build({stdin:{contents:source,resolveDir:resolve('node_modules/pi-acp/dist'),sourcefile:'pi-acp-workbench-adapter.mjs'},outfile:'dist/pi-adapter.mjs',bundle:true,platform:'node',format:'esm',target:'node20',sourcemap:true,
    banner:{js:'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);'}});
}
