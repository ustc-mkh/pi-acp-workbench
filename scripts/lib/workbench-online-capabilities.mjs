// Bounded actual provider settings acceptance, separate from implementation capability claims.
import assert from 'node:assert/strict';
export async function verifyOnlineCapabilities({ wire, session, harness, prompt, report }) {
  const inspect = () => wire.call({ method: 'inspect', session });
  const original = await inspect();
  const result = {
    advertised_modes: original.catalogue.modes,
    advertised_selects: original.catalogue.selects || [],
    mode_roundtrips: [],
    limits: [
      'Settings acknowledgements do not prove reasoning quality, service tier billing, or autonomous wakeups.',
      'Terminal stdout/stderr is unavailable: client declares terminal:false.',
      'No external billing reconciliation or arbitrary media/compaction cut claim.',
    ],
  };
  report.capabilities = result;
  for (const mode of original.catalogue.modes) {
    const receipt = await wire.call(
      { method: 'set_mode', session, mode: mode.id },
      'online-cap-mode-' + mode.id,
    );
    const view = await inspect();
    assert.equal(view.config.mode, mode.id);
    result.mode_roundtrips.push({ id: mode.id, receipt, observed: view.config.mode });
  }
  const afterValid = await inspect();
  await assert.rejects(
    wire.call(
      { method: 'set_mode', session, mode: 'p6-deliberately-invalid-mode' },
      'online-cap-invalid-mode',
    ),
  );
  assert.deepEqual((await inspect()).config, afterValid.config);
  result.invalid_mode_rejected_without_config_change = true;
  const restore =
    original.config.mode ||
    original.catalogue.current_mode ||
    result.advertised_selects.find((s) => s.id === (harness === 'Pi' ? 'thought_level' : 'mode'))
      ?.current_value ||
    (harness === 'Pi' ? 'low' : 'read-only');
  assert(original.catalogue.modes.some((m) => m.id === restore));
  await wire.call({ method: 'set_mode', session, mode: restore }, 'online-cap-restore-mode');
  const fast = result.advertised_selects.find((s) => s.id === 'fast-mode');
  if (fast) {
    assert(
      fast.choices.some((c) => c.value === 'on') && fast.choices.some((c) => c.value === 'off'),
    );
    result.fast = {};
    result.fast.enable_receipt = await wire.call(
      { method: 'set_option', session, id: 'fast-mode', value: 'on' },
      'online-cap-fast-on',
    );
    let v = await inspect();
    assert.equal(v.catalogue.selects.find((s) => s.id === 'fast-mode').current_value, 'on');
    await prompt(
      'Do not use tools. Return only the marker on the following line, with no punctuation, quotation marks, or extra text:\nP6_FAST_ON_OK',
      'fast_on',
      {
        expected: 'P6_FAST_ON_OK',
      },
    );
    const native = (await inspect()).provider_session;
    await wire.call({ method: 'cancel', session }, 'online-cap-fast-stop');
    await wire.call({ method: 'discover', session }, 'online-cap-fast-reload');
    v = await inspect();
    assert.equal(v.provider_session, native);
    assert.equal(v.config.options?.['fast-mode'], 'on');
    result.fast.startup_advertised_value = v.catalogue.selects.find(
      (s) => s.id === 'fast-mode',
    ).current_value;
    result.fast.persisted_preference_before_next_prompt = v.config.options['fast-mode'];
    // Native load advertises provider defaults. Saved host preferences are
    // deliberately configured at the next prompt, before generation starts.
    await prompt(
      'Do not use tools. Return only the marker on the following line, with no punctuation, quotation marks, or extra text:\nP6_FAST_RELOAD_OK',
      'fast_reload',
      {
        expected: 'P6_FAST_RELOAD_OK',
      },
    );
    v = await inspect();
    assert.equal(v.provider_session, native);
    assert.equal(v.catalogue.selects.find((s) => s.id === 'fast-mode').current_value, 'on');
    result.fast.same_native_reload_preserved_on = true;
    await assert.rejects(
      wire.call(
        { method: 'set_option', session, id: 'fast-mode', value: 'p6-invalid' },
        'online-cap-fast-invalid',
      ),
    );
    assert.equal(
      (await inspect()).catalogue.selects.find((s) => s.id === 'fast-mode').current_value,
      'on',
    );
    result.fast.invalid_value_rejected = true;
    result.fast.disable_receipt = await wire.call(
      { method: 'set_option', session, id: 'fast-mode', value: 'off' },
      'online-cap-fast-off',
    );
    await prompt(
      'Do not use tools. Return only the marker on the following line, with no punctuation, quotation marks, or extra text:\nP6_FAST_OFF_OK',
      'fast_off',
      {
        expected: 'P6_FAST_OFF_OK',
      },
    );
    assert.equal(
      (await inspect()).catalogue.selects.find((s) => s.id === 'fast-mode').current_value,
      'off',
    );
    result.fast.actual_prompt_on_and_off = true;
  }
  if (!fast) {
    const before = await inspect();
    let error;
    await assert.rejects(
      wire.call(
        { method: 'set_option', session, id: 'fast-mode', value: 'on' },
        'online-cap-unsupported-fast',
      ),
      (e) => {
        error = String(e.message);
        return true;
      },
    );
    const after = await inspect();
    assert.deepEqual(after.config, before.config);
    assert(!after.catalogue.selects?.some((s) => s.id === 'fast-mode'));
    result.fast = {
      supported: false,
      model: before.config.model,
      rejected: error,
      hidden_in_advertised_ui_catalogue: true,
    };
    report.checks.push(
      'unadvertised Fast for selected model rejected without configuration mutation; catalogue hides control',
    );
  }
  if (harness === 'Codex') {
    const plan = result.advertised_selects.find((s) => s.id === 'collaboration_mode');
    assert(plan?.choices.some((c) => c.value === 'plan'));
    await wire.call(
      { method: 'set_option', session, id: 'collaboration_mode', value: 'plan' },
      'online-cap-plan',
    );
    assert.equal(
      (await inspect()).catalogue.selects.find((s) => s.id === 'collaboration_mode').current_value,
      'plan',
    );
    await prompt(
      'Do not use tools. Return only the marker on the following line, with no punctuation, quotation marks, or extra text:\nP6_PLAN_OK',
      'plan_mode',
      {
        expected: 'P6_PLAN_OK',
      },
    );
    await wire.call(
      { method: 'set_option', session, id: 'collaboration_mode', value: plan.current_value },
      'online-cap-plan-restore',
    );
    assert.equal(
      (await inspect()).catalogue.selects.find((s) => s.id === 'collaboration_mode').current_value,
      plan.current_value,
    );
    result.plan = {
      selected: true,
      actual_model_roundtrip: true,
      restored: plan.current_value,
      scope:
        'Collaboration mode acknowledgement and model response, not a populated task Plan projection.',
    };
  }
  result.final_config = (await inspect()).config;
  report.capabilities = result;
  report.checks.push(
    'actual advertised mode acknowledgements, invalid mode rejection and restored preferences',
  );
  if (fast)
    report.checks.push(
      'actual Fast on/off model roundtrips and same-native physical reload persistence; no billing claim',
    );
}
