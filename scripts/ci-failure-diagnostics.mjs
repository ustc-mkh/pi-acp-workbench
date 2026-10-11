// Make bounded, credential-free mock test/build diagnostics readable without log-download auth.
import { readdirSync, readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  for (const run of readdirSync('.test-results').filter((name) => name.startsWith('run-'))) {
    for (const file of readdirSync(`.test-results/${run}`).filter((name) => name.endsWith('.log')))
      files.push(`.test-results/${run}/${file}`);
  }
}
// GitHub shows at most ten error annotations per step; prioritize TS failure summaries.
files.sort((a, b) => Number(b.endsWith('/typescript.log')) - Number(a.endsWith('/typescript.log')));
for (const file of files.slice(0, 9)) {
  const text = readFileSync(file, 'utf8').split('\n').slice(-80).join('\n');
  const escaped = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::error title=Failure diagnostics::${file}%0A${escaped}`);
}
