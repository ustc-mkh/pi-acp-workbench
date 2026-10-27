// Real VS Code renderer + Extension Host ports. CDP belongs exclusively to the
// runner's private profile; no daily window/profile or online provider is used.
const assert = require('node:assert/strict');
const { readFile, writeFile, access } = require('node:fs/promises');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async ({ vscode, api, root, checkpoint }) => {
  const checks = checkpoint?.checks || [];
  const until = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(25);
    }
    throw new Error(`Native UI timeout: ${label}`);
  };
  const cdp = process.env.WORKBENCH_EXTENSION_CDP_FILE;
  assert.equal(cdp, join(root, '../profile/DevToolsActivePort'));
  await until(
    () =>
      access(cdp).then(
        () => true,
        () => false,
      ),
    'private CDP endpoint',
  );
  const [port, endpoint] = (await readFile(cdp, 'utf8')).trim().split('\n');
  assert(/^\d+$/.test(port) && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint));
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`);
  let page, frame;
  const findView = async () => {
    await until(async () => {
      for (const context of browser.contexts())
        for (const candidate of context.pages())
          for (const content of candidate.frames())
            if (await content.locator('#prompt').count()) {
              page = candidate;
              frame = content;
              return true;
            }
      return false;
    }, 'production webview frame');
  };
  const state = () => api.getState();
  const send = async (text, finish = true) => {
    const previous = state().view.entries.filter((entry) => entry.role === 'User').length;
    await frame.locator('#prompt').fill(text);
    await frame.getByRole('button', { name: '发送消息', exact: true }).click();
    await until(
      () => state().view?.entries.filter((entry) => entry.role === 'User').length > previous,
      `accepted ${text}`,
    );
    const turn = state()
      .view.entries.filter((entry) => entry.role === 'User')
      .at(-1).turn;
    if (finish) {
      await until(
        () =>
          state().view?.view?.status === 'Idle' &&
          !state().view.view.active_turn &&
          state().view.entries.some((entry) => entry.role === 'Agent' && entry.turn === turn),
        `completed fixture turn ${text}`,
      );
    } else {
      await until(() => state().view?.view?.active_turn === turn, `running ${text}`);
    }
    return turn;
  };
  try {
    await findView();
    if (checkpoint) {
      assert.notEqual(
        process.pid,
        checkpoint.host_pid,
        'Reload must start a new Extension Host process',
      );
      await until(
        () => state().selected === checkpoint.session && state().view?.status === 'ready',
        'restored native selection after Reload',
      );
      assert.equal(state().view.view.last_entry_seq, checkpoint.last_entry_seq);
      assert.equal(state().view.view.provider_session, checkpoint.provider_session);
      await until(
        () =>
          state().operations.some(
            (operation) =>
              operation.operation === checkpoint.operation && operation.status === 'completed',
          ),
        'original undo receipt after Reload',
      );
      const trace = await readFile(join(root, '../provider-trace.ndjson'), 'utf8');
      assert.equal(
        trace,
        checkpoint.provider_trace,
        'Reload and receipt recovery must not boot or prompt a provider',
      );
      await until(
        async () => (await frame.locator('#prompt').inputValue()) === 'resized native draft',
        'draft after native Reload',
      );
      assert.equal(await readFile(join(root, 'review.txt'), 'utf8'), 'before\n');
      assert.equal(await readFile(join(root, 'gone.txt'), 'utf8'), 'deleted before\n');
      await assert.rejects(access(join(root, 'added.txt')));
      checks.push(
        'actual window Reload restores selection, draft and original undo receipt without provider replay',
      );
      return {
        passed: true,
        checks,
        reload: {
          before_host: checkpoint.host_pid,
          after_host: process.pid,
          operation: checkpoint.operation,
        },
      };
    }
    await frame.locator('#prompt').fill('IME enter');
    await frame.locator('#prompt').evaluate((input) => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
      );
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await delay(100);
    assert.equal(state().view.entries.length, 0, 'IME confirmation must not send');
    // Compositionend deliberately suppresses that gesture's Enter; the next
    // ordinary user key begins a new gesture before sending.
    await frame.locator('#prompt').press('ArrowLeft');
    await frame.locator('#prompt').press('Enter');
    await until(
      () => state().view?.entries.some((entry) => entry.role === 'User'),
      'ordinary Enter sends',
    );
    await until(
      () =>
        state().view?.view?.status === 'Idle' &&
        state().view.entries.some((entry) => entry.role === 'Agent'),
      'Enter completion',
    );
    checks.push('real webview Enter / IME suppression');

    await vscode.env.clipboard.writeText('p6-owned-clipboard');
    await frame
      .locator('article.assistant')
      .first()
      .getByRole('button', { name: '复制消息', exact: true })
      .click();
    await until(
      async () => (await vscode.env.clipboard.readText()) === 'echo: IME enter',
      'native clipboard copy of committed Agent body',
    );
    checks.push('native clipboard port with test-owned content');

    await until(
      () => state().view?.view?.catalogue.selects?.some((option) => option.id === 'thought_level'),
      'automatically loaded provider settings',
    );
    await frame.getByRole('button', { name: '模型、思考和 Fast 设置', exact: true }).click();
    await frame.getByRole('slider', { name: '思考强度', exact: true }).press('End');
    await until(
      () => state().view?.view?.config.options?.thought_level === 'high',
      'thinking observed',
    );
    await frame.getByRole('button', { name: 'Fast Mode', exact: true }).click();
    await until(() => state().view?.view?.config.options?.fast === 'on', 'Fast observed');
    await frame.locator('[aria-label="思考强度"]').press('Escape');
    checks.push('real settings controls / observed synthetic provider configuration');

    await frame.locator('#prompt').fill('session-local draft');
    const first = state().selected;
    await vscode.commands.executeCommand('piAcp.newSession');
    await until(
      () => state().selected !== first && state().view?.status === 'ready',
      'second session',
    );
    await until(
      async () =>
        (await frame
          .locator('#history-items [aria-selected="true"]')
          .getAttribute('data-session-id')) === state().selected &&
        (await frame.locator('#prompt').inputValue()) === '',
      'new session rendered without old draft',
    );
    await frame.getByRole('button', { name: '历史记录', exact: true }).click();
    await frame.locator(`[data-session-id="${first}"] .history-open`).click();
    await until(
      () => state().selected === first && state().view?.status === 'ready',
      'restore first session',
    );
    await until(
      async () => (await frame.locator('#prompt').inputValue()) === 'session-local draft',
      'restored draft',
    );
    await frame.locator('#prompt').fill('');
    checks.push('native New session / switch / per-session draft restore');

    const selectedPath = join(root, 'selection.ts');
    await writeFile(selectedPath, 'selected fixture\n');
    const document = await vscode.workspace.openTextDocument(selectedPath);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(0, 0, 0, 8);
    await vscode.commands.executeCommand('piAcp.attachSelection');
    await frame.locator('#attachments summary').first().click();
    await frame.locator('#attachments').getByText('selected', { exact: true }).waitFor();
    await frame.getByRole('button', { name: '添加上下文', exact: true }).click();
    const picker = page.locator('.quick-input-widget input').first();
    await picker.waitFor({ state: 'visible' });
    await picker.fill(selectedPath);
    await picker.press('Enter');
    await until(
      async () => (await frame.locator('#attachments summary').count()) === 2,
      'native file picker attachment',
    );
    const png = await frame.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      canvas.getContext('2d').fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await frame.locator('input[type=file]').setInputFiles({
      name: 'fixture.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await frame.locator('#attachments img').waitFor();
    await send('selected image and editor context');
    assert(state().view.entries.some((entry) => entry.role === 'User' && entry.image));
    checks.push('real editor selection / file picker / image preview and sanitized durable input');

    await send('wait', false);
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    assert(state().view.view.active_turn, 'hiding native view must not cancel the host task');
    await vscode.commands.executeCommand('piAcp.open');
    await findView();
    await frame.getByRole('button', { name: '停止输出', exact: true }).click();
    await until(
      () => state().view?.view?.status === 'Idle' && !state().view.view.active_turn,
      'cancel after reopen',
    );
    checks.push('hide/reopen native view retains running task; explicit stop joins');

    const { WorkbenchWire } = await import('./workbench-wire.mjs');
    const socket = vscode.workspace.getConfiguration('piAcp').get('workbenchSocket');
    assert(socket.startsWith(join(root, '../data/')));
    const secondPeer = await WorkbenchWire.open(socket);
    try {
      const session = state().selected;
      const permission = async () => {
        await send('permission', false);
        await until(
          () => Object.keys(state().view.view.pending_interactions).length === 1,
          'native permission visible',
        );
        const interaction = Object.values(state().view.view.pending_interactions)[0];
        await frame
          .locator(`[data-interaction="${interaction.id}"]`)
          .getByRole('button', { name: 'Allow once', exact: true })
          .waitFor();
        return interaction;
      };
      const idle = () =>
        until(
          () => state().view.view.status === 'Idle' && !state().view.view.active_turn,
          'permission terminal',
        );
      const firstPermission = await permission();
      await frame
        .locator(`[data-interaction="${firstPermission.id}"]`)
        .getByRole('button', { name: 'Allow once', exact: true })
        .click();
      await idle();
      await assert.rejects(
        secondPeer.call({
          method: 'answer',
          session,
          answer: { interaction: firstPermission.id, response: { Permission: { option: 'yes' } } },
        }),
        /interaction not found/,
      );
      checks.push(
        'native permission answer commits once; second IPC peer cannot answer the resolved interaction',
      );

      const cancelledPermission = await permission();
      await frame.getByRole('button', { name: '停止输出', exact: true }).click();
      await idle();
      const terminal = await secondPeer.call({ method: 'inspect', session });
      await assert.rejects(
        secondPeer.call({
          method: 'answer',
          session,
          answer: {
            interaction: cancelledPermission.id,
            response: { Permission: { option: 'yes' } },
          },
        }),
        /interaction not found/,
      );
      assert.equal(
        (await secondPeer.call({ method: 'inspect', session })).last_entry_seq,
        terminal.last_entry_seq,
      );
      checks.push(
        'native cancel clears exact pending authorization; late IPC answer cannot append output',
      );

      const oldPermission = await permission();
      await frame
        .locator(`[data-interaction="${oldPermission.id}"]`)
        .getByRole('button', { name: 'Allow once', exact: true })
        .evaluate((button) => {
          window.__p6OldPermission = button;
        });
      await vscode.commands.executeCommand('piAcp.newSession');
      await until(
        () => state().selected !== session && state().view?.status === 'ready',
        'switch away from permission',
      );
      await until(
        async () =>
          (await frame
            .locator('#history-items [aria-selected="true"]')
            .getAttribute('data-session-id')) === state().selected,
        'new selection rendered',
      );
      const oldBefore = await secondPeer.call({ method: 'inspect', session });
      await frame.evaluate(() => {
        window.__p6OldPermission.click();
        delete window.__p6OldPermission;
      });
      await until(() => !!state().error, 'stale native page rejected');
      const oldAfter = await secondPeer.call({ method: 'inspect', session });
      assert.deepEqual(oldAfter.pending_interactions, oldBefore.pending_interactions);
      assert.equal(oldAfter.revision, oldBefore.revision);
      await frame.getByRole('button', { name: '历史记录', exact: true }).click();
      await frame.locator(`[data-session-id="${session}"] .history-open`).click();
      await until(
        () => state().selected === session && state().view?.status === 'ready',
        'restore authorization session',
      );
      await frame.getByRole('button', { name: '停止输出', exact: true }).click();
      await idle();
      checks.push(
        'detached old native permission button cannot authorize a session after selection changes',
      );
    } finally {
      secondPeer.close();
    }

    const reviewTurn = await send('workspace-write');
    const reviewTurnElement = frame.locator(`section.turn[data-turn="${reviewTurn}"]`);
    await reviewTurnElement.locator('.turn-diff-files > summary').waitFor();
    assert.equal(
      await reviewTurnElement.getByRole('button', { name: '查看工作区变更', exact: true }).count(),
      0,
    );
    const diffFiles = reviewTurnElement.locator('.turn-diff-files');
    if (!(await diffFiles.evaluate((node) => node.open)))
      await diffFiles.locator(':scope > summary').click();
    await reviewTurnElement.locator('.turn-diff-file > summary').first().click();
    await reviewTurnElement
      .getByRole('button', { name: '在编辑器中对比', exact: true })
      .first()
      .click();
    await until(
      () =>
        vscode.window.tabGroups.all.some((group) =>
          group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff),
        ),
      'single native Diff editor',
    );
    const diff = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((tab) => tab.input instanceof vscode.TabInputTextDiff).input;
    assert.equal(diff.original.scheme, 'workbench-diff');
    assert.equal(diff.modified.scheme, 'workbench-diff');
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), '');
    assert.equal((await vscode.workspace.openTextDocument(diff.modified)).getText(), 'added\n');
    await frame.getByRole('button', { name: '查看总 Diff', exact: true }).click();
    await until(
      () =>
        vscode.window.tabGroups.all.some((group) =>
          group.tabs.some((tab) => tab.label.includes('workspace changes')),
        ),
      'native multi-file Diff editor',
    );
    checks.push('real single / multi-file native Diff editors with immutable snapshots');

    const review = await vscode.workspace.openTextDocument(join(root, 'review.txt'));
    await vscode.window.showTextDocument(review, { preview: false });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(review.uri, new vscode.Position(0, 0), 'unsaved fixture\n');
    assert(await vscode.workspace.applyEdit(edit));
    assert(review.isDirty);
    await frame.getByRole('button', { name: '撤回本轮修改', exact: true }).last().click();
    await until(
      () => state().error?.includes('Save or close dirty editor buffers'),
      'dirty-buffer undo rejection',
    );
    assert.equal(await readFile(join(root, 'review.txt'), 'utf8'), 'after\n');
    await vscode.window.showTextDocument(review, { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert(!review.isDirty);
    checks.push('native dirty editor buffer prevents undo without touching disk');

    const undo = () =>
      frame.getByRole('button', { name: '撤回本轮修改', exact: true }).last().click();
    await undo();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await readFile(join(root, 'review.txt'), 'utf8'), 'after\n');
    await undo();
    await dialog.getByRole('button', { name: 'Undo turn', exact: true }).click();
    await until(
      () =>
        state().operations.some(
          (operation) => operation.method === 'undo_turn' && operation.status === 'completed',
        ),
      'confirmed native undo receipt',
    );
    assert.equal(await readFile(join(root, 'review.txt'), 'utf8'), 'before\n');
    assert.equal(await readFile(join(root, 'gone.txt'), 'utf8'), 'deleted before\n');
    await assert.rejects(access(join(root, 'added.txt')));
    checks.push('actual Host modal cancellation / confirmation and durable three-file undo');

    const exportPath = join(root, 'native-export.md');
    await frame.getByRole('button', { name: '导出 Markdown', exact: true }).click();
    await picker.waitFor({ state: 'visible' });
    await picker.fill(exportPath);
    await picker.press('Enter');
    await until(
      () =>
        access(exportPath).then(
          () => true,
          () => false,
        ),
      'native save dialog and atomic Markdown export',
    );
    const exported = await readFile(exportPath, 'utf8');
    assert(exported.includes('IME enter') && exported.includes('workspace changes applied'));
    checks.push('actual native save dialog exports full committed Markdown');

    const size = page.viewportSize();
    await page.setViewportSize({ width: 1000, height: 800 });
    await frame.locator('#prompt').fill('resized native draft');
    assert.equal(await frame.locator('#prompt').inputValue(), 'resized native draft');
    if (size) await page.setViewportSize(size);
    checks.push('real renderer resize preserves composer');
    const operation = state().operations.find(
      (item) => item.method === 'undo_turn' && item.status === 'completed',
    ).operation;
    await writeFile(
      join(root, '../native-ui-checkpoint.json'),
      JSON.stringify({
        session: state().selected,
        host_pid: process.pid,
        last_entry_seq: state().view.view.last_entry_seq,
        provider_session: state().view.view.provider_session,
        operation,
        checks,
        provider_trace: await readFile(join(root, '../provider-trace.ndjson'), 'utf8'),
      }),
      { mode: 0o600 },
    );
    // Disposing the old Extension Host can cancel the command promise itself.
    // Only the new process and durable checkpoint can prove Reload succeeded.
    await vscode.commands.executeCommand('workbench.action.reloadWindow').catch((error) => {
      if (error?.name !== 'Canceled' && error?.message !== 'Canceled') throw error;
    });
    await new Promise(() => {}); // the new Extension Host completes the checkpoint
  } catch (error) {
    await writeFile(
      join(root, '../native-ui-failure.json'),
      JSON.stringify({ checks, error: String(error.stack || error) }, null, 2),
    );
    await page?.screenshot({ path: join(root, '../native-ui-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
};
