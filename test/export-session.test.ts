import { beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ dialog: vi.fn(), write: vi.fn() }));
vi.mock('vscode', () => ({
  window: { showSaveDialog: io.dialog },
  Uri: { file: (path: string) => ({ path }) },
  workspace: { fs: { writeFile: io.write } },
}));
import { AttachmentCoordinator, type AttachmentHost } from '../src/conversation-attachments';
import { initialState } from '../src/state';
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const host = {
    state: {
      ...initialState(),
      sessionId: 'A',
      entries: [{ id: 'a', role: 'assistant' as const, text: 'A content' }],
    },
    generation: 1,
    cwd: '/workspace-A',
    harness: 'pi' as const,
    config: { get: () => false },
    emit: vi.fn(),
    postOutputImage: vi.fn(),
    documents: { open: vi.fn() },
    serviceClient: { call: vi.fn() },
  } as unknown as AttachmentHost & { generation: number; cwd: string };
  return { host, coordinator: new AttachmentCoordinator(host) };
}
for (const change of ['generation', 'session', 'cwd'] as const) {
  it(`cancels export when ${change} changes during the save dialog`, async () => {
    const { host, coordinator } = fixture();
    let resolve!: (uri: object) => void;
    io.dialog.mockImplementation(
      () =>
        new Promise((pass) => {
          resolve = pass;
        }),
    );
    const exporting = coordinator.exportChat();
    if (change === 'generation') host.generation++;
    else if (change === 'session') host.state.sessionId = 'B';
    else host.cwd = '/workspace-B';
    resolve({ path: '/workspace-A/export.md' });
    await expect(exporting).rejects.toThrow('会话已切换');
    expect(io.write).not.toHaveBeenCalled();
    expect(host.serviceClient.call).not.toHaveBeenCalled();
  });
}
it('exports the selected conversation when its identity remains stable', async () => {
  const { coordinator } = fixture();
  io.dialog.mockResolvedValue({ path: '/export.md' });
  await coordinator.exportChat();
  expect(Buffer.from(io.write.mock.calls[0][1]).toString()).toContain('A content');
});
it('does not write after switching during history pagination', async () => {
  const { host, coordinator } = fixture();
  host.state.historyBefore = 1;
  io.dialog.mockResolvedValue({ path: '/export.md' });
  vi.mocked(host.serviceClient.call).mockImplementation(async () => {
    host.generation++;
    return { entries: [{ id: 'old', role: 'user', text: 'old' }], remaining: 0 } as never;
  });
  await expect(coordinator.exportChat()).rejects.toThrow('会话已切换');
  expect(io.write).not.toHaveBeenCalled();
});
