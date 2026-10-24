// Explicit opt-in: real, potentially billed model requests against an isolated workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm, copyFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { tmpdir, homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { verifyOnlinePermission } from './lib/workbench-online-permission.mjs';
import { verifyOnlinePlan } from './lib/workbench-online-plan.mjs';
import { verifyOnlineAutonomous } from './lib/workbench-online-autonomous.mjs';
import { verifyOnlineForm } from './lib/workbench-online-form.mjs';
import { verifyOnlineCapabilities } from './lib/workbench-online-capabilities.mjs';
import { WorkbenchWire, inlineText } from '../test/helpers/workbench-wire.mjs';
const { values } = parseArgs({
  options: {
    authorized: { type: 'boolean', default: false },
    extended: { type: 'boolean', default: false },
    'form-probe': { type: 'boolean', default: false },
    'autonomous-probe': { type: 'boolean', default: false },
    'plan-probe': { type: 'boolean', default: false },
    'permission-probe': { type: 'boolean', default: false },
    capabilities: { type: 'boolean', default: false },
    harness: { type: 'string' },
    model: { type: 'string' },
    binary: { type: 'string' },
  },
});
assert(values.authorized, 'Real account/model use requires explicit authorization');
assert(['Pi', 'Codex', 'Claude'].includes(values.harness));
const harness = values.harness,
  binary = resolve(values.binary || 'service-dist/pi-acp-workbenchd');
const evidence = resolve('.test-results', `online-v1-${harness.toLowerCase()}-${randomUUID()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(tmpdir(), 'workbench-online-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const report = {
  version: 1,
  harness,
  real_model_requests_authorized: true,
  binary_sha256: createHash('sha256')
    .update(await readFile(binary))
    .digest('hex'),
  checks: [],
  passed: false,
  scope:
    'Actual GNU host and provider ACP adapter; isolated test-owned workspace; bounded model prompts. No deployment or billing-service audit.',
};
let host, wire, piProfile;
const logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Online timeout: ${label}`);
}
try {
  const base = resolve('.test-results/p6/online-tools/node_modules/.bin');
  let worker;
  if (harness === 'Pi') {
    const profile = join(root, 'pi-profile');
    piProfile = profile;
    await mkdir(profile, { mode: 0o700 });
    for (const file of ['auth.json', 'models.json', 'models-store.json'])
      await copyFile(join(homedir(), '.pi/agent', file), join(profile, file)).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    const prefs = JSON.parse(await readFile(join(homedir(), '.pi/agent/settings.json'), 'utf8'));
    await writeFile(
      join(profile, 'settings.json'),
      JSON.stringify({
        defaultProvider: prefs.defaultProvider,
        defaultModel: prefs.defaultModel,
        defaultThinkingLevel: 'low',
        packages: [],
        extensions: [
          ...(values['form-probe'] || values['autonomous-probe']
            ? [resolve('test/helpers/pi-input-probe.mjs')]
            : []),
          ...(values['autonomous-probe'] ? [resolve('test/helpers/pi-autonomous-probe.mjs')] : []),
          ...(values['plan-probe'] ? [resolve('test/helpers/pi-plan-probe.mjs')] : []),
        ],
        skills: [],
        promptTemplates: [],
        themes: [],
      }),
      { mode: 0o600 },
    );
    worker = {
      command: process.execPath,
      args: [resolve('dist/pi-adapter.mjs')],
      env: {
        PI_CODING_AGENT_DIR: profile,
        PI_ACP_WORKBENCH_STATE_DIR: join(root, 'pi-adapter-state'),
      },
    };
  } else
    worker = {
      command: join(base, harness === 'Codex' ? 'codex-acp' : 'claude-agent-acp'),
      args: [],
      env: harness === 'Codex' ? { CODEX_PATH: join(homedir(), '.local/bin/codex') } : {},
    };
  report.adapter = { command: worker.command, environment_keys: Object.keys(worker.env) };
  const config = join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      workers: { [harness.toLowerCase()]: worker },
      storage: { root: join(root, 'data') },
      sessions: { mailbox: 128, max_workers: 1 },
      limits: { pending_interactions: 32 },
    }),
    { mode: 0o600 },
  );
  host = spawn(binary, ['--config', config], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: homedir(), LANG: 'C.UTF-8' },
  });
  let output = '';
  for (const stream of [host.stdout, host.stderr])
    stream.on('data', (b) => {
      output = (output + b).slice(-131072);
    });
  host.done = new Promise((res, rej) => {
    host.once('error', rej);
    host.once('exit', (code, signal) => res({ code, signal }));
  });
  await until(
    () => {
      if (host.exitCode !== null) throw new Error('Host startup failed');
      return output.includes('ready:');
    },
    'host ready',
    10000,
  );
  wire = await WorkbenchWire.open(join(root, 'data/workbench.sock'));
  const session = (await wire.call({ method: 'create', harness, cwd: workspace })).Created.summary
    .id;
  const discovered = await wire.call({ method: 'discover', session });
  report.discovery = discovered;
  report.checks.push('real provider startup/discovery');
  if (values.model) {
    report.requested_model = values.model;
    report.model_selection = await wire.call(
      { method: 'set_model', session, model: values.model },
      'online-explicit-model',
    );
  }
  async function prompt(text, label, { target = session, parts, expected } = {}) {
    const session = target;
    const before = await wire.call({ method: 'history', session, limit: 100 });
    const receipt = await wire.call(
      { method: 'prompt', session, prompt: { parts: parts || [{ type: 'text', text }] } },
      `online-${label}`,
    );
    await until(async () => {
      const v = await wire.call({ method: 'inspect', session });
      if (Object.keys(v.pending_interactions).length)
        throw new Error('Interactive authorization required; retained as explicit pending state');
      return !v.active_turn;
    }, label);
    const after = await wire.call({ method: 'history', session, limit: 100 });
    const added = after.entries.filter((e) => !before.entries.some((p) => p.id === e.id));
    report[label] = {
      receipt,
      entries: added.map((e) => ({
        id: e.id,
        role: e.role,
        text: inlineText(e),
        image: e.image,
        usage: e.usage,
      })),
      view: await wire.call({ method: 'inspect', session }),
    };
    const agentText = added
      .filter((e) => e.role === 'Agent')
      .map((e) => inlineText(e) || '')
      .join('');
    report[label].agent_text = agentText;
    assert(
      agentText.trim(),
      'Provider finished without inline agent text; see saved view and entries',
    );
    expected ||= label === 'reload' ? 'P6_RELOADED_OK' : 'P6_ONLINE_OK';
    assert.equal(
      agentText.trim(),
      expected,
      'Actual provider response must match the requested marker',
    );
  }
  await prompt('Reply with exactly P6_ONLINE_OK. Do not use tools or read any files.', 'text');
  report.checks.push('actual model text roundtrip through committed host history');
  await prompt(
    'What exact marker did you reply with in the previous turn? Reply only that marker; do not use tools.',
    'continuation',
  );
  report.checks.push('same native provider session continues with prior context');
  const before = report.continuation.view;
  await wire.call({ method: 'cancel', session });
  await prompt('Reply exactly P6_RELOADED_OK. Do not use tools.', 'reload');
  assert.equal(report.reload.view.provider_session, before.provider_session);
  report.checks.push('physical stop and native load preserve provider identity');

  if (values['permission-probe']) {
    assert.equal(harness, 'Codex');
    await verifyOnlinePermission({ wire, session, workspace, report, until });
  }

  if (values['plan-probe']) {
    assert.equal(harness, 'Pi');
    await verifyOnlinePlan({ wire, session, prompt, report });
  }

  if (values['autonomous-probe']) {
    assert.equal(harness, 'Pi');
    await verifyOnlineAutonomous({ wire, session, workspace, prompt, report, until });
  }

  if (values.capabilities)
    await verifyOnlineCapabilities({ wire, session, harness, prompt, report });

  if (values.extended) {
    const view = await wire.call({ method: 'inspect', session });
    const mode = harness === 'Pi' ? 'low' : 'read-only';
    assert(view.catalogue.modes.some((m) => m.id === mode));
    report.extended_mode = {
      requested: mode,
      receipt: await wire.call({ method: 'set_mode', session, mode }, 'online-extended-mode'),
      view: await wire.call({ method: 'inspect', session }),
    };
    assert.equal(report.extended_mode.view.config.mode, mode);
    report.checks.push('actual provider mode selection: ' + mode);
    assert.equal(view.catalogue.image_input, true);
    // Test-owned 32x32 RGB red PNG with standard chunks and CRC; no external image data.
    function crc32(b) {
      let c = 0xffffffff;
      for (const byte of b) {
        c ^= byte;
        for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
      return (c ^ 0xffffffff) >>> 0;
    }
    function chunk(type, data) {
      const t = Buffer.from(type),
        n = Buffer.alloc(4),
        crc = Buffer.alloc(4);
      n.writeUInt32BE(data.length);
      crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
      return Buffer.concat([n, t, data, crc]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(32, 0);
    ihdr.writeUInt32BE(32, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const pixels = Buffer.alloc((1 + 32 * 3) * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) pixels[y * 97 + 1 + x * 3] = 255;
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const image = {
      id: 'p6-online-image-' + randomUUID(),
      mime: 'image/png',
      bytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    };
    await prompt('', 'image', {
      expected: 'P6_IMAGE_RED',
      parts: [
        {
          type: 'text',
          text: 'Inspect the attached image. If its dominant colour is red, reply exactly P6_IMAGE_RED. Otherwise reply WRONG_COLOUR. Do not use tools or read files.',
        },
        { type: 'image', asset: { format_version: 1, image, data: png.toString('base64') } },
      ],
    });
    report.image_fixture = image;
    const storedImage = report.image.entries.find((e) => e.image)?.image;
    assert(storedImage && storedImage.id === image.id);
    const archivedImage = await wire.call({ method: 'image', image: storedImage });
    const archivedBytes = Buffer.from(archivedImage.data, 'base64');
    assert.equal(createHash('sha256').update(archivedBytes).digest('hex'), storedImage.sha256);
    assert.equal(archivedBytes.length, storedImage.bytes);
    assert.equal(archivedBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(archivedBytes.readUInt32BE(16), 32);
    assert.equal(archivedBytes.readUInt32BE(20), 32);
    report.image_archive = {
      reference: storedImage,
      bytes_verified: true,
      width: 32,
      height: 32,
      scope: 'Canonical sanitized PNG; hash may differ from raw input.',
    };
    report.checks.push('actual inline PNG input and model colour recognition');
    const priorNative = report.image.view.provider_session;
    const beforeActive = await wire.call({ method: 'history', session, limit: 100 });
    report.active_cancel = {
      receipt: await wire.call(
        {
          method: 'prompt',
          session,
          prompt: {
            parts: [
              {
                type: 'text',
                text: 'Output the integers 1 through 100000, one per line, without explanation. Do not use tools or files. Continue until stopped.',
              },
            ],
          },
        },
        'online-extended-active',
      ),
    };
    await until(async () => {
      const v = await wire.call({ method: 'inspect', session });
      const h = await wire.call({ method: 'history', session, limit: 100 });
      const fresh = h.entries.filter((e) => !beforeActive.entries.some((x) => x.id === e.id));
      if (!v.active_turn)
        throw new Error('Generation completed before active cancel could be tested');
      return fresh.some((e) => e.role === 'Agent' && inlineText(e));
    }, 'active generation has committed output');
    report.active_cancel.before = await wire.call({ method: 'inspect', session });
    const cancelStarted = Date.now();
    report.active_cancel.cancel_receipt = await wire.call(
      { method: 'cancel', session },
      'online-extended-cancel',
    );
    report.active_cancel.roundtrip_including_join_ms = Date.now() - cancelStarted;
    await until(
      async () => !(await wire.call({ method: 'inspect', session })).active_turn,
      'active cancel settled',
    );
    report.active_cancel.after = await wire.call({ method: 'inspect', session });
    await prompt('Reply exactly P6_AFTER_CANCEL_OK. Do not use tools.', 'after_cancel', {
      expected: 'P6_AFTER_CANCEL_OK',
    });
    assert.equal(report.after_cancel.view.provider_session, priorNative);
    report.checks.push(
      'cancel during committed streaming output, normal settle and same-native continuation',
    );
    if (harness === 'Pi') {
      const sourceBefore = await wire.call({ method: 'history', session, limit: 100 });
      const duplicate = report.text.entries.findLast((e) => e.role === 'Agent');
      assert(duplicate);
      await assert.rejects(
        wire.call(
          { method: 'fork', session, request: { entry: duplicate.id } },
          'online-extended-duplicate-cut',
        ),
        /unsafe, stale or ambiguous/,
      );
      report.duplicate_fork_rejected = {
        entry: duplicate.id,
        reason: 'same Agent text in two complete turns; fail closed',
      };
      const cut = report.after_cancel.entries.findLast((e) => e.role === 'Agent');
      assert(cut);
      async function nativeFiles(directory) {
        const files = [];
        for (const e of await readdir(directory, { withFileTypes: true })) {
          const file = join(directory, e.name);
          if (e.isDirectory()) files.push(...(await nativeFiles(file)));
          else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(file);
        }
        return files;
      }
      async function nativeFile(id) {
        const matches = [];
        for (const f of await nativeFiles(piProfile)) {
          const first = (await readFile(f, 'utf8')).split('\n')[0];
          try {
            if (JSON.parse(first).id === id) matches.push(f);
          } catch {}
        }
        assert.equal(matches.length, 1, 'exactly one test-owned native session file');
        return matches[0];
      }
      const sourceFile = await nativeFile(priorNative);
      const sourceHash = createHash('sha256')
        .update(await readFile(sourceFile))
        .digest('hex');
      const sourceUsage = (await wire.call({ method: 'inspect', session })).usage;
      const receipt = await wire.call(
        { method: 'fork', session, request: { entry: cut.id } },
        'online-extended-fork',
      );
      const branch = receipt.Forked.summary.id;
      const branchView = await wire.call({ method: 'inspect', session: branch });
      assert.notEqual(branchView.provider_session, priorNative);
      assert.equal(branchView.origin.session, session);
      assert.equal(branchView.usage.input_tokens, 0);
      assert.equal(branchView.usage.output_tokens, 0);
      assert.equal(branchView.usage.cost_micros, 0);
      await prompt('Reply exactly P6_BRANCH_OK. Do not use tools.', 'branch', {
        target: branch,
        expected: 'P6_BRANCH_OK',
      });
      assert.deepEqual(await wire.call({ method: 'history', session, limit: 100 }), sourceBefore);
      assert.deepEqual(
        await wire.call(
          { method: 'fork', session, request: { entry: cut.id } },
          'online-extended-fork',
        ),
        receipt,
      );
      assert.equal(
        createHash('sha256')
          .update(await readFile(sourceFile))
          .digest('hex'),
        sourceHash,
      );
      assert.deepEqual((await wire.call({ method: 'inspect', session })).usage, sourceUsage);
      const branchFile = await nativeFile(branchView.provider_session);
      assert.notEqual(branchFile, sourceFile);
      report.native_fork = {
        source_file_sha256_unchanged: sourceHash,
        source_usage_unchanged: sourceUsage,
        branch_usage_before_prompt: branchView.usage,
        branch_file_sha256: createHash('sha256')
          .update(await readFile(branchFile))
          .digest('hex'),
        receipt,
        branch_view: branchView,
        cut_entry: cut.id,
        source_history_unchanged: true,
        receipt_replayed: true,
        scope:
          'Actual native branch identities and committed source history; not external billing reconciliation or arbitrary compaction/media cuts.',
      };
      report.checks.push(
        'actual Pi native fork at committed entry, branch prompt, source history unchanged and original receipt replay',
      );
    }
    report.extended_uncovered = [
      'external billing reconciliation',
      'terminal stdout/stderr contract',
      'Fast/Plan/autonomous provider behaviour',
      'provider-native permission/other elicitation variants; Pi extension text Form separately tested with --form-probe',
      'arbitrary native fork boundary/media/compaction matrix',
    ];
  }

  if (values['form-probe']) {
    assert.equal(harness, 'Pi');
    if (report.native_fork) {
      const branch = report.native_fork.receipt.Forked.summary.id;
      report.form_preflight_branch_stop = await wire.call(
        { method: 'cancel', session: branch },
        'online-form-preflight-stop-branch',
      );
    }
    report.input_form = await verifyOnlineForm({ wire, session, workspace, until, piProfile });
    report.checks.push(
      'actual Pi SDK text Form positive answer, pending stop/join, late rejection and original answer receipt replay',
    );
  }
  report.passed = true;
  logs.push(output);
} catch (e) {
  report.error = {
    name: e.name,
    code: e.code,
    message: String(e.message).replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_\-.]+/g, '[REDACTED]'),
  };
  process.exitCode = 1;
} finally {
  wire?.close();
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM');
    const timer = setTimeout(() => host.kill('SIGKILL'), 10000);
    try {
      report.shutdown = await host.done;
      if (report.shutdown.code !== 0 || report.shutdown.signal !== null) {
        report.passed = false;
        report.error ??= { message: 'Host did not exit normally' };
        process.exitCode = 1;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  // Credentials and native profile are always erased. Preserve other isolated
  // evidence on failure instead of deleting the database before diagnosis.
  if (piProfile) await rm(piProfile, { recursive: true, force: true });
  if (report.passed) await rm(root, { recursive: true, force: true });
  else report.retained_root_without_profile = root;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`${report.passed ? 'PASS' : 'FAIL'} online ${harness}: ${evidence}`);
  if (report.error) console.log(JSON.stringify(report.error));
}
