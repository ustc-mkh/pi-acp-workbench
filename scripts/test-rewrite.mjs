import { spawnSync } from 'node:child_process';

// Keep each gate visible and fail at the first unsuccessful verification.
const checks = [
  ['npm', ['run', 'audit:workbench']],
  ['npm', ['run', 'format:check']],
  ['npm', ['run', 'clippy']],
  ['npm', ['run', 'test:full']],
  ['node', ['scripts/workbench-idle-worker-repro.mjs']],
  ['node', ['scripts/workbench-image-race.mjs']],
  ['node', ['scripts/workbench-provider-barriers.mjs']],
  ['node', ['scripts/build-services.mjs']],
  ['npm', ['run', 'package:services']],
  ['npm', ['run', 'test:service:artifact', '--', '--dir', 'service-dist']],
];

for (const [command, args] of checks) {
  console.log(`\n=== Rewrite verification: ${command} ${args.join(' ')} ===`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) console.error(result.error);
  if (result.error || result.signal || result.status !== 0) {
    process.exit(result.status || 1);
  }
}
