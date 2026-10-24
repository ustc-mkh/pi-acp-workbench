import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function verifyOnlineAutonomous({ wire, session, workspace, prompt, report, until }) {
  const inspect = () => wire.call({ method: 'inspect', session });
  const history = () => wire.call({ method: 'history', session, limit: 200 });
  const result = {
    scope:
      'Actual Pi SDK sendMessage(triggerTurn:true), real provider/tool elicitation and committed host autonomous turn. Gate controlled by test client; not a synthetic provider notification.',
  };
  report.autonomous = result;
  async function arm(n) {
    await prompt(
      'Call p6_arm_autonomous exactly once. Then return only the following marker, no punctuation or other tools:\nP6_AUTO_ARMED',
      'auto_arm_' + n,
      { expected: 'P6_AUTO_ARMED' },
    );
    assert.equal(await readFile(join(workspace, `p6-auto-armed-${n}`), 'utf8'), 'ARMED\n');
    const v = await inspect();
    assert.equal(v.active_turn, null);
    const h = await history();
    await wire.call({ method: 'attach', session });
    await history();
    assert.equal(
      (await inspect()).revision,
      v.revision,
      'cold/read-only operations cannot trigger pending background gate',
    );
    return { view: v, history: h };
  }
  async function wake(n, before) {
    await writeFile(join(workspace, `p6-auto-release-${n}`), 'GO\n');
    let v;
    await until(async () => {
      v = await inspect();
      return Object.keys(v.pending_interactions).length > 0;
    }, 'autonomous Form ' + n);
    assert(v.active_turn);
    assert.notEqual(
      v.active_turn,
      before.history.entries.filter((e) => e.role === 'User').at(-1)?.turn,
    );
    const pending = Object.values(v.pending_interactions);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'Elicitation');
    const h = await history();
    assert(
      h.entries.some(
        (e) => e.turn === v.active_turn && e.text.Inline?.text?.includes('Pi autonomous run.'),
      ),
      'durable autonomous-run annotation',
    );
    return { view: v, interaction: pending[0] };
  }
  const first = await arm(1),
    w = await wake(1, first);
  result.first = {
    foreground_revision: first.view.revision,
    autonomous_turn: w.view.active_turn,
    interaction: w.interaction,
  };
  const conflict = 'P6_CONFLICT_NOT_SENT';
  const beforeConflict = await history();
  let conflictError;
  await assert.rejects(
    wire.call(
      { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: conflict }] } },
      'online-auto-conflict',
    ),
    (e) => {
      conflictError = String(e.message);
      return true;
    },
  );
  const afterConflict = await history();
  assert.equal(
    afterConflict.entries.some((e) => e.role === 'User' && e.text.Inline?.text === conflict),
    false,
  );
  assert.equal(
    afterConflict.entries.filter((e) => e.role === 'User').length,
    beforeConflict.entries.filter((e) => e.role === 'User').length,
  );
  result.conflict = { rejected: conflictError, input_not_dispatched: true, literal: conflict };
  const answer = {
    method: 'answer',
    session,
    answer: {
      interaction: w.interaction.id,
      response: { Form: { fields: { value: { Text: 'P6_ALLOW' } } } },
    },
  };
  const receipt = await wire.call(answer, 'online-auto-positive-answer');
  await until(async () => !(await inspect()).active_turn, 'autonomous completed');
  assert.equal(await readFile(join(workspace, 'p6-permission.txt'), 'utf8'), 'P6_PERMISSION_OK\n');
  const h = await history();
  const groups = new Map();
  for (const entry of h.entries.filter(
    (e) => e.turn === w.view.active_turn && e.role === 'Agent' && e.message,
  )) {
    groups.set(entry.message, (groups.get(entry.message) || '') + (entry.text.Inline?.text || ''));
  }
  const lastMessage = [...groups.entries()].at(-1);
  assert(lastMessage, 'actual provider message group exists');
  const texts = lastMessage[1];
  assert.equal(texts.trim(), 'P6_AUTO_DONE');
  result.first.provider_message_id = lastMessage[0];
  result.first.agent_message_groups = [...groups.entries()].map(([message, text]) => ({
    message,
    text,
  }));
  result.first.agent_text = texts;
  result.first.answer_receipt = receipt;
  await prompt(
    'Return only the marker on the next line, no punctuation or tools:\nP6_AFTER_AUTO_OK',
    'after_auto',
    { expected: 'P6_AFTER_AUTO_OK' },
  );
  const second = await arm(2),
    v = await wake(2, second);
  const start = performance.now();
  result.pending_cancel = {
    turn: v.view.active_turn,
    interaction: v.interaction.id,
    receipt: await wire.call({ method: 'cancel', session }, 'online-auto-pending-stop'),
    ms_including_join: performance.now() - start,
  };
  const stopped = await inspect();
  assert.equal(stopped.active_turn, null);
  assert.equal(Object.keys(stopped.pending_interactions).length, 0);
  let late;
  await assert.rejects(
    wire.call(
      {
        method: 'answer',
        session,
        answer: {
          interaction: v.interaction.id,
          response: { Form: { fields: { value: { Text: 'P6_ALLOW' } } } },
        },
      },
      'online-auto-late-answer',
    ),
    (e) => {
      late = String(e.message);
      return /interaction.*not.*found/i.test(late);
    },
  );
  result.pending_cancel.late_rejected = late;
  assert.equal(await readFile(join(workspace, 'p6-permission.txt'), 'utf8'), 'P6_PERMISSION_OK\n');
  assert.deepEqual(await wire.call(answer, 'online-auto-positive-answer'), receipt);
  result.answer_receipt_replayed = true;
  const cold = await history();
  await wire.call({ method: 'inspect', session });
  assert.equal((await history()).entries.length, cold.entries.length);
  result.cold_queries_no_new_entries = true;
  await prompt(
    'Return only the marker on the next line, no punctuation or tools:\nP6_AUTO_STOP_RESUMED',
    'after_auto_stop',
    { expected: 'P6_AUTO_STOP_RESUMED' },
  );
  report.checks.push(
    'actual autonomous background wake without host prompt, Form answer and completion, conflict input not dispatched, pending Form physical stop/late rejection/old receipt replay/cold reads/explicit same-session continuation',
  );
}
