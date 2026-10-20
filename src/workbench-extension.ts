import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { WorkbenchClient } from './workbench-client';
import { WorkbenchController } from './workbench-controller';
import { readTextAttachment } from './workbench-attachments';
import { MAX_ATTACHMENTS } from './workbench-input';
import { telegramConfiguration } from './workbench-setup';

function isWithin(root: string, target: string) {
  const part = relative(root, target);
  return part === '' || (!part.startsWith('..' + '/') && part !== '..' && !isAbsolute(part));
}
async function hasDirtyDocuments(cwd: string) {
  const root = await realpath(cwd);
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || document.uri.scheme !== 'file') continue;
    const target = await realpath(document.uri.fsPath).catch(() => document.uri.fsPath);
    if (isWithin(root, target)) return true;
  }
  return false;
}
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
    // Only immutable daemon snapshots enter this provider. No URI maps to disk.
    const snapshots = new Map<string, string>();
    this.resources.push(
      vscode.workspace.registerTextDocumentContentProvider('workbench-diff', {
        provideTextDocumentContent: (uri) => {
          const text = snapshots.get(uri.toString());
          if (text === undefined) throw new Error('Snapshot expired; reopen the turn diff');
          return text;
        },
      }),
    );
    const configured = vscode.workspace.getConfiguration('piAcp').get<string>('workbenchSocket');
    const path = configured || join(homedir(), '.pi', 'pi-acp-workbench', 'workbench.sock');
    const client = new WorkbenchClient(path, {
      lost: (error) => this.log.appendLine(error.message),
    });
    const operationKey = `workbench.operations:${path}`;
    this.controller = new WorkbenchController(client, {
      loadSelection: () => context.workspaceState?.get(`workbench.selection:${path}`),
      saveSelection: (session) =>
        context.workspaceState?.update(`workbench.selection:${path}`, session) ?? Promise.resolve(),
      loadOperations: () => context.workspaceState?.get(operationKey),
      saveOperations: (operations) =>
        context.workspaceState?.update(operationKey, operations) ?? Promise.resolve(),
      trusted: () => vscode.workspace.isTrusted,
      copyText: (text) => vscode.env.clipboard.writeText(text),
      configureTelegram: async () => {
        const trusted = () => {
          if (!vscode.workspace.isTrusted) throw new Error('Workspace trust changed');
        };
        trusted();
        const directories = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Choose allowed Telegram workspace',
        });
        if (!directories?.[0]) return;
        if (directories[0].scheme !== 'file') throw new Error('Choose a local directory');
        const workspace = await realpath(directories[0].fsPath);
        const tokenEnv = await vscode.window.showInputBox({
          title: 'Bot token environment variable (not the secret token)',
          value: 'TELEGRAM_BOT_TOKEN',
          ignoreFocusOut: true,
        });
        if (tokenEnv === undefined) return;
        const user = await vscode.window.showInputBox({
          title: 'Explicitly authorized Telegram user ID',
          ignoreFocusOut: true,
        });
        if (user === undefined) return;
        const chat = await vscode.window.showInputBox({
          title: 'Allowed private/group chat ID (groups are negative)',
          ignoreFocusOut: true,
        });
        if (chat === undefined) return;
        const config = telegramConfiguration({
          workspace,
          root: join(homedir(), '.pi', 'pi-acp-workbench'),
          tokenEnv,
          user,
          chat,
        });
        trusted();
        const destination = await vscode.window.showSaveDialog({
          title: 'Save NEW workbench config (no installation or restart)',
          defaultUri: vscode.Uri.file(join(workspace, 'workbench.generated.json')),
          filters: { JSON: ['json'] },
        });
        if (!destination) return;
        trusted();
        if (destination.scheme !== 'file') throw new Error('Choose a local config file');
        const file = await open(destination.fsPath, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(config, null, 2) + '\n');
          await file.sync();
        } finally {
          await file.close();
        }
        await vscode.window.showInformationMessage(
          `Config created. Set ${tokenEnv} in the daemon environment, inspect the explicit allowed IDs, then start the single daemon yourself. No credentials were saved and no service was installed.`,
        );
      },
      openDiff: async (turn, files) => {
        snapshots.clear();
        const resources = files.map((file) => {
          const id = randomUUID();
          const original = vscode.Uri.from({
            scheme: 'workbench-diff',
            path: `/${id}/before/${file.path}`,
          });
          const modified = vscode.Uri.from({
            scheme: 'workbench-diff',
            path: `/${id}/after/${file.path}`,
          });
          snapshots.set(original.toString(), file.before);
          snapshots.set(modified.toString(), file.after);
          return { original, modified };
        });
        if (resources.length === 1) {
          await vscode.commands.executeCommand(
            'vscode.diff',
            resources[0].original,
            resources[0].modified,
            `${turn} · ${files[0].path}`,
          );
        } else {
          await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
            title: `Turn ${turn} · workspace changes`,
            resources: resources.map(({ original, modified }) => ({
              originalUri: original,
              modifiedUri: modified,
            })),
          });
        }
      },
      confirmUndo: async (_session, turn) => {
        if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required');
        const view = this.controller.snapshot.view;
        if (!view || !view.view || view.view.active_turn || view.view.id !== _session)
          throw new Error('Session changed or task is active');
        const cwd = view.view.cwd;
        if (await hasDirtyDocuments(cwd))
          throw new Error('Save or close dirty editor buffers before undo');
        const choice = await vscode.window.showWarningMessage(
          `Undo workspace changes from turn ${turn}? This does not change chat history or model context. Multi-file undo can partially fail. External editors and residual background processes are not locked; inspect the diff first.`,
          { modal: true },
          'Undo turn',
        );
        return choice === 'Undo turn';
      },
      validateUndo: async (_session) => {
        const view = this.controller.snapshot.view?.view;
        if (!vscode.workspace.isTrusted || !view || view.active_turn || view.id !== _session)
          throw new Error('Workspace trust, session, or task state changed');
        if (await hasDirtyDocuments(view.cwd))
          throw new Error('Save or close dirty editor buffers before undo');
        await this.controller.authorizeForUndo?.(view.cwd);
      },
      attachFiles: async (cwd) => {
        if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required');
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: 'Attach text files',
          filters: {
            'Text and source files': [
              'txt',
              'md',
              'json',
              'yaml',
              'yml',
              'toml',
              'rs',
              'ts',
              'tsx',
              'js',
              'jsx',
              'py',
              'go',
              'java',
              'c',
              'h',
              'cpp',
              'html',
              'css',
              'sql',
              'sh',
            ],
          },
        });
        if (!result?.length) return [];
        if (result.length > MAX_ATTACHMENTS)
          throw new Error(`Attach at most ${MAX_ATTACHMENTS} files at once`);
        const attachments = await Promise.all(
          result.map(async (uri) => {
            if (uri.scheme !== 'file')
              throw new Error('Only local workspace files can be attached');
            const file = await readTextAttachment(uri.fsPath, cwd);
            return { id: randomUUID(), ...file };
          }),
        );
        if (!vscode.workspace.isTrusted) throw new Error('Workspace trust changed');
        return attachments;
      },
      exportMarkdown: async (session, chunks) => {
        const destination = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(
            join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir(), `${session}.md`),
          ),
          filters: { Markdown: ['md'] },
          title: 'Export full committed transcript',
        });
        if (!destination) return;
        if (destination.scheme !== 'file') throw new Error('Choose a local Markdown file');
        const directory = await mkdtemp(join(dirname(destination.fsPath), '.workbench-export-'));
        const temporary = join(directory, 'transcript.md');
        try {
          const output = await open(temporary, 'wx', 0o600);
          try {
            for await (const chunk of chunks) await output.writeFile(chunk, 'utf8');
            await output.sync();
          } finally {
            await output.close();
          }
          if (!vscode.workspace.isTrusted) throw new Error('Workspace trust changed');
          await rename(temporary, destination.fsPath);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
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
    this.resources.push(
      ...[
        vscode.workspace.onDidChangeWorkspaceFolders?.(() =>
          this.controller.invalidateAuthorization(),
        ),
        vscode.workspace.onDidGrantWorkspaceTrust?.(() =>
          this.controller.invalidateAuthorization(),
        ),
      ].filter((item): item is vscode.Disposable => Boolean(item)),
    );
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const nonce = randomBytes(24).toString('base64url');
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(dist, file));
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${view.webview.cspSource}; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; img-src blob:; connect-src 'none';">
<link rel="stylesheet" href="${uri('style.css')}"><link rel="stylesheet" href="${uri('katex.min.css')}"></head>
<body><main id="workbench"></main><script type="module" nonce="${nonce}" src="${uri('webview.js')}"></script></body></html>`;
    this.resources.push(
      view.webview.onDidReceiveMessage((message: unknown) => void this.controller.receive(message)),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
        this.controller.invalidateAuthorization();
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
