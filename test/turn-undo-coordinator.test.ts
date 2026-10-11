import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialState } from '../src/state';
import type { AttachmentHost } from '../src/conversation-attachments';
const ui = vi.hoisted(() => ({
  warning: vi.fn(),
  call: vi.fn(),
  info: vi.fn(),
  workspace: {
    isTrusted: true,
    textDocuments: [] as { isDirty: boolean; uri: { scheme: string; fsPath: string } }[],
  },
}));
vi.mock('vscode', () => ({
  workspace: ui.workspace,
  window: { showWarningMessage: ui.warning, showInformationMessage: ui.info },
}));
import { AttachmentCoordinator } from '../src/conversation-attachments';
let cwd: string;
let host: AttachmentHost & { generation: number };
let coordinator: AttachmentCoordinator;
const message = { type: 'undoTurn' as const, id: 'diff', sessionId: 'session' };
beforeEach(async () => {
  vi.clearAllMocks();
  ui.workspace.isTrusted = true;
  ui.workspace.textDocuments = [];
  ui.warning.mockResolvedValue('撤回本轮修改');
  cwd = await mkdtemp(join(tmpdir(), 'undo-coordinator-'));
  await writeFile(join(cwd, 'file'), 'after\n');
  host = {
    cwd,
    generation: 1,
    harness: 'pi',
    state: {
      ...initialState(),
      sessionId: 'session',
      status: 'ready',
      entries: [
        {
          id: 'diff',
          role: 'diff',
          text: '',
          diff: {
            status: 'complete',
            warnings: [],
            files: [
              {
                path: 'file',
                status: 'modified',
                before: 'before\n',
                after: 'after\n',
                added: 1,
                removed: 1,
              },
            ],
          },
        },
      ],
    },
    config: { get: (_key: string, fallback?: unknown) => fallback } as AttachmentHost['config'],
    documents: { open: vi.fn() },
    serviceClient: { call: ui.call },
    postOutputImage: vi.fn(),
    emit: vi.fn(),
  };
  ui.call.mockImplementation(async (_method, params) => {
    if ((await readFile(join(cwd, 'file'), 'utf8')) !== 'after\n') throw new Error('文件已有修改');
    if (!params.checkOnly) await writeFile(join(cwd, 'file'), 'before\n');
    return true;
  });
  coordinator = new AttachmentCoordinator(host);
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
it('confirms before reverting files and preserves chat entries', async () => {
  const entries = structuredClone(host.state.entries);
  await coordinator.onUndoTurn(message);
  expect(ui.warning).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ modal: true }),
    '撤回本轮修改',
  );
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('before\n');
  expect(host.state.entries).toEqual(entries);
  expect(ui.info).toHaveBeenCalled();
  expect(ui.call).toHaveBeenNthCalledWith(1, 'undoTurn', {
    sessionId: 'session',
    entryId: 'diff',
    checkOnly: true,
  });
  expect(ui.call).toHaveBeenNthCalledWith(
    2,
    'undoTurn',
    { sessionId: 'session', entryId: 'diff' },
    undefined,
    0,
  );
});
it('does not write when confirmation is cancelled', async () => {
  ui.warning.mockResolvedValue(undefined);
  await coordinator.onUndoTurn(message);
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('after\n');
  expect(ui.info).not.toHaveBeenCalled();
});
it('rejects dirty editor buffers before confirmation', async () => {
  ui.workspace.textDocuments = [
    { isDirty: true, uri: { scheme: 'file', fsPath: join(cwd, 'file') } },
  ];
  await expect(coordinator.onUndoTurn(message)).rejects.toThrow('未保存');
  expect(ui.warning).not.toHaveBeenCalled();
});
it('rechecks dirty buffers after confirmation', async () => {
  ui.warning.mockImplementation(async () => {
    ui.workspace.textDocuments = [
      { isDirty: true, uri: { scheme: 'file', fsPath: join(cwd, 'file') } },
    ];
    return '撤回本轮修改';
  });
  await expect(coordinator.onUndoTurn(message)).rejects.toThrow('未保存');
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('after\n');
});
it('rechecks disk contents after confirmation', async () => {
  ui.warning.mockImplementation(async () => {
    await writeFile(join(cwd, 'file'), 'user edit');
    return '撤回本轮修改';
  });
  await expect(coordinator.onUndoTurn(message)).rejects.toThrow('已有修改');
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('user edit');
});
it('rejects changed session generation after confirmation', async () => {
  ui.warning.mockImplementation(async () => {
    host.generation++;
    return '撤回本轮修改';
  });
  await expect(coordinator.onUndoTurn(message)).rejects.toThrow('会话已切换');
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('after\n');
});
it('rejects stale session IDs, preview, untrusted workspaces and active turns', async () => {
  await expect(coordinator.onUndoTurn({ ...message, sessionId: 'old' })).rejects.toThrow(
    '会话已切换',
  );
  host.state.preview = true;
  await expect(coordinator.onUndoTurn(message)).rejects.toThrow('预览');
  host.state.preview = false;
  ui.workspace.isTrusted = false;
  await expect(coordinator.onUndoTurn(message)).rejects.toThrow('信任');
  ui.workspace.isTrusted = true;
  host.state.status = 'busy';
  await expect(coordinator.onUndoTurn(message)).rejects.toThrow('任务结束');
  expect(ui.warning).not.toHaveBeenCalled();
});
