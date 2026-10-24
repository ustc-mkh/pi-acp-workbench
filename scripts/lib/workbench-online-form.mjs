// Actual Pi SDK/adapter Form roundtrip; the authorized test client supplies the answer.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export async function verifyOnlineForm({ wire, session, workspace, until, piProfile }) {
  const inspect = () => wire.call({ method: 'inspect', session });
  async function requested(label) {
    let view;
    await until(async () => {
      view = await inspect();
      if (Object.keys(view.pending_interactions).length) return true;
      assert(
        view.active_turn,
        `provider ended ${label} without requesting a Form: ${JSON.stringify(view.status)}`,
      );
      return false;
    }, label);
    const interactions = Object.values(view.pending_interactions);
    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].kind, 'Elicitation');
    assert.equal(interactions[0].fields[0].name, 'value');
    return { view, interaction: interactions[0] };
  }
  const instruction =
    '只调用 p6_permission_probe 一次，等待工具真实结果。成功才回复 P6_PERMISSION_OK，取消则回复 P6_PERMISSION_CANCELLED。不要使用其他工具。';
  await wire.call(
    { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: instruction }] } },
    'online-form-positive-prompt',
  );
  const positive = await requested('actual Pi extension input Form');
  const answer = {
    method: 'answer',
    session,
    answer: {
      interaction: positive.interaction.id,
      response: { Form: { fields: { value: { Text: 'P6_ALLOW' } } } },
    },
  };
  const receipt = await wire.call(answer, 'online-form-positive-answer');
  await until(async () => !(await inspect()).active_turn, 'Form tool completion');
  async function nativeToolEvidence() {
    const files = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const f = join(dir, entry.name);
        if (entry.isDirectory()) await walk(f);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(f);
      }
    }
    await walk(piProfile);
    const id = (await inspect()).provider_session;
    const found = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
      if (lines[0]?.id === id) found.push({ file, lines });
    }
    assert.equal(found.length, 1, 'one actual source native file');
    const tools = found[0].lines.filter(
      (row) =>
        row.type === 'message' &&
        row.message?.role === 'toolResult' &&
        row.message.toolName === 'p6_permission_probe',
    );
    const success = tools.filter((row) => row.message.details?.authorized === true);
    assert.equal(success.length, 1, 'exactly one native tool result authorized the write');
    assert.equal(success[0].message.isError, false);
    assert(
      success[0].message.content.some(
        (block) => block.type === 'text' && block.text === 'P6_PERMISSION_OK',
      ),
    );
    return {
      native_entry: success[0].id,
      tool_call: success[0].message.toolCallId,
      authorized: true,
      isError: false,
      marker: 'P6_PERMISSION_OK',
    };
  }
  const nativeEvidence = await nativeToolEvidence();
  const marker = join(workspace, 'p6-permission.txt');
  const bytes = await readFile(marker);
  assert.equal(bytes.toString(), 'P6_PERMISSION_OK\n');
  const hash = () => readFile(marker).then((b) => createHash('sha256').update(b).digest('hex'));
  const before = await hash();
  await wire.call(
    {
      method: 'prompt',
      session,
      prompt: { parts: [{ type: 'text', text: '再次' + instruction }] },
    },
    'online-form-cancel-prompt',
  );
  const pending = await requested('second Pi Form to cancel');
  const start = performance.now();
  const cancelled = await wire.call({ method: 'cancel', session }, 'online-form-cancel');
  const elapsed = performance.now() - start;
  const stopped = await inspect();
  assert.equal(stopped.active_turn, null);
  assert.equal(Object.keys(stopped.pending_interactions).length, 0);
  const late = {
    method: 'answer',
    session,
    answer: {
      interaction: pending.interaction.id,
      response: { Form: { fields: { value: { Text: 'P6_ALLOW' } } } },
    },
  };
  let lateError;
  await assert.rejects(wire.call(late, 'online-form-late-answer'), (error) => {
    lateError = String(error.message);
    return /interaction.*not.*found/i.test(lateError);
  });
  assert.equal(await hash(), before, 'cancelled/late Form must not overwrite the marker');
  assert.deepEqual(
    await wire.call(answer, 'online-form-positive-answer'),
    receipt,
    'old answer receipt replays without invoking the tool',
  );
  assert.deepEqual(await nativeToolEvidence(), nativeEvidence);
  return {
    native_tool_evidence: nativeEvidence,
    positive_interaction: positive.interaction,
    answer_receipt: receipt,
    marker_sha256: before,
    pending_cancel_interaction: pending.interaction,
    cancel_receipt: cancelled,
    cancel_ms_including_join: elapsed,
    late_answer_error: lateError,
    marker_unchanged: true,
    answer_receipt_replayed: true,
    scope:
      'Actual model/tool and standard elicitation; answer supplied by authorized test client, not a new human Telegram window.',
  };
}
