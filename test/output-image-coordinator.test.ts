import { it, expect, vi, beforeEach } from 'vitest';
const { read, trusted } = vi.hoisted(() => ({ read: vi.fn(), trusted: { value: true } }));
vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return trusted.value;
    },
  },
}));
vi.mock('../src/output-image', () => ({ readOutputImage: read }));
import { AttachmentCoordinator } from '../src/conversation-attachments';
import { initialState } from '../src/state';
beforeEach(() => {
  read.mockReset();
  trusted.value = true;
});
function fixture() {
  const host = {
    config: { get: vi.fn() },
    state: initialState(),
    harness: 'pi' as const,
    cwd: '/workspace',
    generation: 1,
    documents: { open: vi.fn() },
    emit: vi.fn(),
    postOutputImage: vi.fn(),
  };
  host.state.sessionId = 'one';
  const coordinator = new AttachmentCoordinator(host);
  const message = {
    type: 'readOutputImage' as const,
    id: 'image',
    url: 'a.png',
    harness: 'pi' as const,
    sessionId: 'one',
  };
  return { host, coordinator, message };
}
it('checks trust and session/harness scopes and drops generation-stale file reads', async () => {
  const { host, coordinator, message } = fixture();
  await coordinator.onReadOutputImage({ ...message, sessionId: 'other' });
  await coordinator.onReadOutputImage({ ...message, harness: 'codex' });
  expect(read).not.toHaveBeenCalled();
  trusted.value = false;
  await coordinator.onReadOutputImage(message);
  expect(host.postOutputImage).toHaveBeenLastCalledWith(
    expect.objectContaining({ error: expect.any(String) }),
  );
  trusted.value = true;
  host.postOutputImage.mockClear();
  let resolve!: (v: unknown) => void;
  read.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = coordinator.onReadOutputImage(message);
  host.generation++;
  resolve({ mimeType: 'image/png', data: 'AAAA', name: 'a.png' });
  await pending;
  expect(host.postOutputImage).toHaveBeenCalledWith({
    type: 'outputImage',
    id: 'image',
    error: expect.any(String),
  });
  expect(host.postOutputImage.mock.calls[0][0].image).toBeUndefined();
});
it('bounds concurrent host reads and returns recoverable errors', async () => {
  const { host, coordinator, message } = fixture();
  let resolve!: (v: unknown) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  read.mockReturnValue(pending);
  const jobs = Array.from({ length: 4 }, (_, i) =>
    coordinator.onReadOutputImage({ ...message, id: String(i) }),
  );
  await coordinator.onReadOutputImage(message);
  expect(read).toHaveBeenCalledTimes(4);
  expect(host.postOutputImage).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'image', error: expect.any(String) }),
  );
  resolve({ mimeType: 'image/png', data: 'AAAA', name: 'a.png' });
  await Promise.all(jobs);
  expect(host.postOutputImage).toHaveBeenCalledTimes(5);
  read.mockRejectedValueOnce(new Error('sensitive path'));
  await coordinator.onReadOutputImage(message);
  expect(host.postOutputImage.mock.calls.at(-1)?.[0].error).not.toContain('sensitive');
});
