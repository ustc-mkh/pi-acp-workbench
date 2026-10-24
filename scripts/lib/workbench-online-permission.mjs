import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function verifyOnlinePermission({ wire, session, workspace, report, until }) {
  const inspect = () => wire.call({ method: 'inspect', session });
  const result = {
    scope:
      'Actual Codex ACP native edit approval in read-only mode; isolated workspace only. Test client grants a single action, then cancels a second pending edit.',
  };
  report.native_permission = result;
  await wire.call({ method: 'set_mode', session, mode: 'read-only' }, 'codex-permission-mode');
  const exists = async (file) =>
    readFile(file).then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    );
  async function request(file, label) {
    assert.equal(await exists(join(workspace, file)), false);
    await wire.call(
      {
        method: 'prompt',
        session,
        prompt: {
          parts: [
            {
              type: 'text',
              text: `Use apply_patch to create ${file} in the current workspace with exactly P6_CODEX_PERMISSION_OK and a newline. Read-only mode is intentional: request approval for this file edit and wait for the real approval response. Do not bypass approval or use another write method. If rejected, stop. Only after the edit succeeds reply P6_CODEX_PERMISSION_OK.`,
            },
          ],
        },
      },
      label,
    );
    let view;
    await until(async () => {
      view = await inspect();
      if (Object.keys(view.pending_interactions).length) return true;
      assert(
        view.active_turn,
        `native edit ended without requesting permission: ${JSON.stringify(view.status)}`,
      );
      return false;
    }, label);
    const items = Object.values(view.pending_interactions);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'Permission');
    assert.equal(await exists(join(workspace, file)), false, 'no file before approval');
    return { view, interaction: items[0] };
  }
  const first = await request('p6-codex-permission.txt', 'codex-permission-positive');
  const option = first.interaction.options.find(
    (o) => o.label === 'Yes, proceed' || /just this once/i.test(o.label),
  );
  assert(option, 'single-action allow choice offered by actual provider');
  const answer = {
    method: 'answer',
    session,
    answer: { interaction: first.interaction.id, response: { Permission: { option: option.id } } },
  };
  const receipt = await wire.call(answer, 'codex-permission-answer');
  await until(async () => !(await inspect()).active_turn, 'native authorized edit');
  assert.equal(
    await readFile(join(workspace, 'p6-codex-permission.txt'), 'utf8'),
    'P6_CODEX_PERMISSION_OK\n',
  );
  result.authorized = {
    turn: first.view.active_turn,
    interaction: first.interaction,
    option,
    receipt,
    file_verified: true,
  };
  const second = await request('p6-codex-cancelled.txt', 'codex-permission-second');
  const start = performance.now();
  const stopped = await wire.call({ method: 'cancel', session }, 'codex-permission-stop');
  assert.equal(await exists(join(workspace, 'p6-codex-cancelled.txt')), false);
  const view = await inspect();
  assert.equal(view.active_turn, null);
  assert.equal(Object.keys(view.pending_interactions).length, 0);
  let error;
  await assert.rejects(
    wire.call(
      {
        method: 'answer',
        session,
        answer: {
          interaction: second.interaction.id,
          response: { Permission: { option: option.id } },
        },
      },
      'codex-permission-late',
    ),
    (e) => {
      error = String(e.message);
      return /interaction.*not.*found/i.test(error);
    },
  );
  assert.equal(await exists(join(workspace, 'p6-codex-cancelled.txt')), false);
  assert.deepEqual(await wire.call(answer, 'codex-permission-answer'), receipt);
  result.cancelled = {
    turn: second.view.active_turn,
    interaction: second.interaction,
    receipt: stopped,
    ms_including_join: performance.now() - start,
    late_error: error,
    file_absent: true,
  };
  result.positive_receipt_replayed = true;
  report.checks.push(
    'actual Codex native read-only edit permission, no write before answer, allow-once file creation, pending stop/late rejection/no file and original receipt replay',
  );
}
