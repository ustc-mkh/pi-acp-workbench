// Executed only by the real VS Code Extension Host, not Vitest or a vscode mock.
const assert = require('node:assert/strict');
const vscode = require('vscode');
exports.run = async () => {
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
  await vscode.commands.executeCommand('piAcp.newSession');
  const deadline = Date.now() + 10000;
  while (!api.getState().selected && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  const state = api.getState();
  assert(state.selected, 'Native contributed command must create/select a durable session');
  assert(!state.error, state.error);
  assert(state.sessions.some((s) => s.id === state.selected && s.cwd === root));
  await assert.rejects(() =>
    vscode.workspace.openTextDocument(
      vscode.Uri.parse('workbench-diff:/unregistered/before/no-network-or-file-authority'),
    ),
  );
  console.log(
    'PASS real Extension Host: contributed command activation, trusted temporary workspace, IPC session creation, unknown snapshot rejection',
  );
};
