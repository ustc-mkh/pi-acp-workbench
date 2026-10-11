import { beforeEach, expect, it, vi } from 'vitest';

const vscode = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  openExternal: vi.fn(async (_uri: unknown) => true),
  writeText: vi.fn(async () => {}),
}));
vi.mock('vscode', () => ({
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  window: { showWarningMessage: vscode.showWarningMessage },
  env: { openExternal: vscode.openExternal, clipboard: { writeText: vscode.writeText } },
  workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }) },
}));
import { openExternalLink, openWorkspaceLink } from '../src/workspace-documents';

beforeEach(() => vi.clearAllMocks());

it('opens agent links only after explicit confirmation of the normalised target', async () => {
  vscode.showWarningMessage.mockResolvedValueOnce(undefined);
  await openWorkspaceLink('/tmp', 'https://exаmple.com/path');
  expect(vscode.openExternal).not.toHaveBeenCalled();
  const [, options] = vscode.showWarningMessage.mock.calls[0];
  // Homograph hosts are shown as punycode so the user sees the real destination.
  expect(options).toMatchObject({ modal: true });
  expect(options.detail).toContain('xn--');

  vscode.showWarningMessage.mockResolvedValueOnce('打开链接');
  await openExternalLink('https://example.com/a b');
  expect(vscode.openExternal).toHaveBeenCalledTimes(1);
  expect(String(vscode.openExternal.mock.calls[0][0])).toBe('https://example.com/a%20b');
});

it('can copy instead of opening and rejects credential-bearing or non-web links', async () => {
  vscode.showWarningMessage.mockResolvedValueOnce('复制链接');
  await openExternalLink('mailto:dev@example.com');
  expect(vscode.writeText).toHaveBeenCalledWith('mailto:dev@example.com');
  expect(vscode.openExternal).not.toHaveBeenCalled();

  await expect(openExternalLink('https://user:pw@example.com')).rejects.toThrow(/用户名或密码/);
  await openExternalLink('javascript:alert(1)');
  expect(vscode.showWarningMessage).toHaveBeenCalledTimes(1);
});
