// Executed only by the real VS Code Extension Host, not Vitest or a vscode mock.
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { writeFile, readFile } = require('node:fs/promises');
exports.run = async () => {
  if (process.env.WORKBENCH_EXTENSION_TRUST_TEST === '1') return require('./trust-ui.cjs').run();
  const extension = vscode.extensions.getExtension('local-pi.pi-acp-workbench');
  assert(extension, 'Development extension must be loaded');
  const api = await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'piAcp.open',
    'piAcp.newSession',
    'piAcp.attachSelection',
    'piAcp.logs',
    'piAcp.login',
  ])
    assert(commands.includes(command), command);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert(
    root && root.startsWith(process.env.HOME.replace(/\/home$/, '') + '/workspace'),
    'Only the runner-created workspace is permitted',
  );
  const socket = vscode.workspace.getConfiguration('piAcp').get('workbenchSocket');
  assert(socket.startsWith(process.env.HOME.replace(/\/home$/, '') + '/data/'));
  const checkpoint = process.env.WORKBENCH_EXTENSION_CDP_FILE
    ? await readFile(
        process.env.HOME.replace(/\/home$/, '') + '/native-ui-checkpoint.json',
        'utf8',
      ).then(JSON.parse, () => undefined)
    : undefined;
  await vscode.commands.executeCommand(checkpoint ? 'piAcp.open' : 'piAcp.newSession');
  const deadline = Date.now() + 10000;
  while (!api.getState().selected && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  const state = api.getState();
  assert(state.selected, 'Native contributed command must create/select a durable session');
  if (checkpoint) assert.equal(state.selected, checkpoint.session);
  assert(!state.error, state.error);
  assert(state.sessions.some((s) => s.id === state.selected && s.cwd === root));
  await assert.rejects(() =>
    vscode.workspace.openTextDocument(
      vscode.Uri.parse('workbench-diff:/unregistered/before/no-network-or-file-authority'),
    ),
  );
  const result = process.env.WORKBENCH_EXTENSION_TEST_REPORT;
  assert.equal(result, process.env.HOME.replace(/\/home$/, '') + '/extension-host-result.json');
  const nativeUi = process.env.WORKBENCH_EXTENSION_CDP_FILE
    ? await require('./native-ui.cjs').run({ vscode, api, root, checkpoint })
    : undefined;
  await writeFile(
    result,
    JSON.stringify(
      {
        version: 1,
        passed: true,
        workspace: root,
        session: state.selected,
        host_pid: process.pid,
        vscode: vscode.version,
        checks: [
          'contributed commands',
          'trusted isolated workspace',
          'durable session creation',
          'unregistered snapshot refusal',
        ],
        native_ui: nativeUi,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'PASS real Extension Host: contributed command activation, trusted temporary workspace, IPC session creation, unknown snapshot rejection',
  );
};
