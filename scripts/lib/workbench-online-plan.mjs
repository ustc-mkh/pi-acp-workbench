import assert from 'node:assert/strict';
export async function verifyOnlinePlan({ wire, session, prompt, report }) {
  await prompt(
    'Call the todo tool exactly once. Then return only the next-line marker, no punctuation or other tools:\nP6_PLAN_CREATED',
    'pi_plan_created',
    { expected: 'P6_PLAN_CREATED' },
  );
  const before = await wire.call({ method: 'inspect', session });
  const expected = [
    { description: 'P6_PENDING_TASK', status: 'Pending' },
    { description: 'P6_ACTIVE_TASK', status: 'InProgress' },
  ];
  assert.deepEqual(before.plan.items, expected);
  await wire.call({ method: 'cancel', session }, 'pi-plan-physical-stop');
  await wire.call({ method: 'discover', session }, 'pi-plan-native-reload');
  const restored = await wire.call({ method: 'inspect', session });
  assert.equal(restored.provider_session, before.provider_session);
  assert.deepEqual(restored.plan.items, expected);
  // The extension has a new process after load. Branch snapshot is authoritative;
  // do not assume its in-memory invocation counter survived.
  report.pi_plan = {
    created: before.plan,
    restored: restored.plan,
    same_native: true,
    completed_tasks_filtered: true,
    scope:
      'Actual SDK branch-local rpiv-todo-state and installed Todo bridge -> typed host Plan; test extension supplies tool state, not third-party global Todo storage.',
  };
  report.checks.push(
    'real Pi SDK branch-local Todo Plan projection, completed task filtering and same-native physical reload',
  );
}
