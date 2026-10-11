// Make bounded, credential-free mock test/build diagnostics readable without log-download auth.
import { readdirSync, readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  for (const run of readdirSync('.test-results').filter((name) => name.startsWith('run-'))) {
    for (const file of readdirSync(`.test-results/${run}`).filter((name) => name.endsWith('.log')))
      files.push(`.test-results/${run}/${file}`);
  }
}
for (const file of files) {
  const text = readFileSync(file, 'utf8').split('\n').slice(-80).join('\n');
  const escaped = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::error title=Failure diagnostics::${file}%0A${escaped}`);
}
