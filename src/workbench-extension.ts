import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { WorkbenchClient } from './workbench-client';
import { WorkbenchController } from './workbench-controller';

/** New production entry. Legacy extension/controller/wire files are not imported or bundled. */
export function activate(context: vscode.ExtensionContext) {
  const provider = new WorkbenchProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('piAcp.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  const command = (name: string, run: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, run));
  command('piAcp.open', () => vscode.commands.executeCommand('piAcp.chat.focus'));
  command('piAcp.newSession', async () => {
    await vscode.commands.executeCommand('piAcp.chat.focus');
    await provider.newSession();
  });
  command('piAcp.attachSelection', () => provider.attachSelection());
  command('piAcp.logs', () => provider.log.show());
  command('piAcp.login', () =>
    vscode.window.showInformationMessage(
      'Provider accounts and worker commands are configured by pi-acp-workbenchd. Use the provider CLI login in a terminal; no credentials are sent through this view.',
    ),
  );
  return { getState: () => provider.controller.snapshot };
}
export class WorkbenchProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly log = vscode.window.createOutputChannel('Pi Workbench');
  readonly controller: WorkbenchController;
  private view?: vscode.WebviewView;
  private resources: vscode.Disposable[] = [];
  constructor(private context: vscode.ExtensionContext) {
    const configured = vscode.workspace.getConfiguration('piAcp').get<string>('workbenchSocket');
    const path = configured || join(homedir(), '.pi', 'pi-acp-workbench', 'workbench.sock');
    const client = new WorkbenchClient(path, {
      lost: (error) => this.log.appendLine(error.message),
    });
    this.controller = new WorkbenchController(client, {
      trusted: () => vscode.workspace.isTrusted,
      workspace: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      authorize: async (cwd) => {
        if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required');
        const source = await realpath(cwd);
        const roots = await Promise.all(
          (vscode.workspace.workspaceFolders || []).map((folder) => realpath(folder.uri.fsPath)),
        );
        if (
          !roots.some((root) => {
            const part = relative(root, source);
            return (
              part === '' || (!part.startsWith('..' + '/') && part !== '..' && !isAbsolute(part))
            );
          })
        )
          throw new Error('Open this session workspace before continuing it');
      },
      post: (message) => {
        void this.view?.webview.postMessage(message).then(undefined, () => {});
      },
    });
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const nonce = randomBytes(24).toString('base64url');
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(dist, file));
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${view.webview.cspSource}; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; img-src data:; connect-src 'none';">
<link rel="stylesheet" href="${uri('style.css')}"><link rel="stylesheet" href="${uri('katex.min.css')}"></head>
<body><main id="workbench"></main><script type="module" nonce="${nonce}" src="${uri('webview.js')}"></script></body></html>`;
    this.resources.push(
      view.webview.onDidReceiveMessage((message: unknown) => void this.controller.receive(message)),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    );
  }
  async newSession() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      await vscode.window.showWarningMessage('Open a trusted local workspace first');
      return;
    }
    await this.controller.receive({
      type: 'create',
      command: { method: 'create', harness: 'Pi', cwd },
    });
  }
  async attachSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return;
    const text = editor.document.getText(editor.selection);
    if ([...text].length > 80000) {
      await vscode.window.showWarningMessage('Selection is too large for a prompt');
      return;
    }
    await vscode.commands.executeCommand('piAcp.chat.focus');
    // Explicit user selection only. No tool metadata/URI may cause a file read.
    void this.view?.webview
      .postMessage({ type: 'draft', text: `${editor.document.fileName}\n\n${text}` })
      .then(undefined, () => {});
  }
  dispose() {
    this.controller.dispose();
    this.resources.splice(0).forEach((resource) => resource.dispose());
    this.log.dispose();
  }
}
