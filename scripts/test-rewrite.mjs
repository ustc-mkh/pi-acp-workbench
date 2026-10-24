import { spawnSync } from 'node:child_process';

// Keep each gate visible and fail at the first unsuccessful verification.
const checks = [
  ['npm', ['run', 'check']],
  ['npm', ['run', 'audit:workbench']],
  ['npm', ['run', 'build']],
  ['npm', ['run', 'format:check']],
  ['npm', ['run', 'clippy']],
  ['cargo', ['test', '--manifest-path', 'rust/Cargo.toml', '--workspace']],
  ['npm', ['run', 'test:contract:workbench']],
  ['npm', ['run', 'test:contract:workbench:telegram']],
  ['npm', ['run', 'test:workbench:capacity']],
  ['npm', ['run', 'test:workbench:process-loss']],
  ['npm', ['run', 'test:workbench:image-race']],
  ['npm', ['run', 'test:workbench:provider-barriers']],
  ['npm', ['run', 'test:browser']],
  ['npm', ['run', 'test:full']],
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
