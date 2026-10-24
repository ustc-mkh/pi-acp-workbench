// Actual VS Code trust editor; only the isolated test driver supports untrusted workspaces.
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');
exports.run = async () => {
  const base = process.env.HOME.replace(/\/home$/, '');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.equal(root, join(base, 'workspace'));
  const file = join(base, 'trust-checkpoint.json');
  const checkpoint = await readFile(file, 'utf8').then(JSON.parse, () => ({
    phase: 'initial',
    checks: [],
    transitions: [],
  }));
  const until = async (check, label) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Trust UI timeout: ${label}`);
  };
  await until(
    () =>
      readFile(join(base, 'profile/DevToolsActivePort')).then(
        () => true,
        () => false,
      ),
    'CDP',
  );
  const [port, endpoint] = (await readFile(join(base, 'profile/DevToolsActivePort'), 'utf8'))
    .trim()
    .split('\n');
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`);
  let page = browser.contexts()[0].pages()[0],
    frame;
  const save = async (phase) => {
    checkpoint.phase = phase;
    checkpoint.transitions.push({ phase, pid: process.pid, trusted: vscode.workspace.isTrusted });
    await writeFile(file, JSON.stringify(checkpoint), { mode: 0o600 });
  };
  const product = () => vscode.extensions.getExtension('local-pi.pi-acp-workbench');
  const activate = async () => {
    assert(vscode.workspace.isTrusted);
    return product().activate();
  };
  const findView = async () => {
    await until(async () => {
      for (const p of browser.contexts()[0].pages())
        for (const f of p.frames())
          if (await f.locator('#prompt').count()) {
            page = p;
            frame = f;
            return true;
          }
      return false;
    }, 'workbench view');
  };
  const trust = async (value) => {
    await vscode.commands.executeCommand('workbench.trust.manage');
    const button = page.getByRole('button', { name: value ? 'Trust' : "Don't Trust", exact: true });
    await button.waitFor({ state: 'visible' });
    await button.click().catch(async (e) => {
      if (/closed|Canceled/.test(String(e))) await new Promise(() => {});
      throw e;
    });
    await until(() => vscode.workspace.isTrusted === value, 'trust transition');
  };
  try {
    if (checkpoint.phase === 'initial') {
      assert.equal(vscode.workspace.isTrusted, false);
      assert(!product()?.isActive);
      if (product()) await assert.rejects(() => product().activate());
      else assert(!(await vscode.commands.getCommands(true)).includes('piAcp.newSession'));
      checkpoint.checks.push('actual Restricted Mode refuses production extension activation');
      await save('grant');
      await trust(true);
    }
    if (checkpoint.phase === 'grant') {
      await until(() => vscode.workspace.isTrusted, 'initial grant');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      const api = await activate();
      await vscode.commands.executeCommand('piAcp.newSession');
      await until(
        () => api.getState().selected && api.getState().view?.status === 'ready',
        'trusted session',
      );
      await findView();
      await frame.locator('#prompt').fill('permission');
      await frame.getByRole('button', { name: 'Send', exact: true }).click();
      await until(
        () => Object.keys(api.getState().view?.view?.pending_interactions || {}).length === 1,
        'pending authorization',
      );
      checkpoint.session = api.getState().selected;
      checkpoint.interaction = Object.keys(api.getState().view.view.pending_interactions)[0];
      checkpoint.provider = api.getState().view.view.provider_session;
      checkpoint.checks.push(
        'native Trust enables extension and creates a real pending authorization',
      );
      await save('revoked');
      await trust(false);
    }
    if (checkpoint.phase === 'revoked') {
      await until(() => !vscode.workspace.isTrusted, 'revocation');
      // VS Code unloads extensions which do not support Restricted Mode.
      await until(() => !product()?.isActive, 'production extension unloaded');
      if (product()) await assert.rejects(() => product().activate());
      else assert(!(await vscode.commands.getCommands(true)).includes('piAcp.newSession'));
      const { WorkbenchWire } = await import('./workbench-wire.mjs');
      const wire = await WorkbenchWire.open(join(base, 'data/workbench.sock'));
      try {
        const state = await wire.call({ method: 'inspect', session: checkpoint.session });
        assert(state.active_turn);
        assert(state.pending_interactions[checkpoint.interaction]);
        assert.equal(state.provider_session, checkpoint.provider);
      } finally {
        wire.close();
      }
      checkpoint.checks.push(
        'native trust revocation unloads extension without answering or replaying the pending host task',
      );
      await save('regrant');
      await trust(true);
    }
    if (checkpoint.phase === 'regrant') {
      await until(() => vscode.workspace.isTrusted, 'regrant');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      const api = await activate();
      await vscode.commands.executeCommand('piAcp.open');
      await until(
        () =>
          api.getState().selected === checkpoint.session && api.getState().view?.status === 'ready',
        'restored trusted session',
      );
      await findView();
      assert(api.getState().view.view.pending_interactions[checkpoint.interaction]);
      await frame
        .locator(`[data-interaction="${checkpoint.interaction}"]`)
        .getByRole('button', { name: 'Allow once', exact: true })
        .click();
      await until(
        () => api.getState().view.view.status === 'Idle' && !api.getState().view.view.active_turn,
        'original authorization settled',
      );
      const trace = (await readFile(join(base, 'provider-trace.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(trace.filter((x) => x.method === 'session/prompt').length, 1);
      assert.equal(
        trace.filter(
          (x) => x.method === 'agent-response' && x.id === 'perm-1' && x.outcome === 'selected',
        ).length,
        1,
      );
      checkpoint.checks.push(
        'native regrant restores the original interaction; exactly one provider prompt and answer',
      );
      await save('complete');
      await writeFile(
        process.env.WORKBENCH_EXTENSION_TEST_REPORT,
        JSON.stringify(
          {
            version: 1,
            passed: true,
            workspace: root,
            session: checkpoint.session,
            host_pid: process.pid,
            vscode: vscode.version,
            checks: checkpoint.checks,
            native_ui: {
              passed: true,
              checks: checkpoint.checks,
              trust_transitions: checkpoint.transitions,
            },
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
    }
  } catch (e) {
    await writeFile(
      join(base, 'native-ui-failure.json'),
      JSON.stringify(
        {
          checkpoint,
          error: String(e.stack || e),
          body: await page
            .locator('body')
            .innerText()
            .catch(() => undefined),
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: join(base, 'native-ui-failure.png') }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
};
