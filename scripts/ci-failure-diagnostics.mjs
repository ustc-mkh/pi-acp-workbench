// Make bounded, credential-free mock test/build diagnostics readable without log-download auth.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

const files = process.argv.slice(2);
if (!files.length) {
  const runs = readdirSync('.test-results', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
    .map((entry) => `.test-results/${entry.name}`)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const run = runs[0];
  if (run && existsSync(`${run}/failures.json`)) {
    for (const file of JSON.parse(readFileSync(`${run}/failures.json`, 'utf8')))
      files.push(`${run}/${file}`);
  } else {
    console.log(
      '::warning::No failed-suite manifest; inspect the uploaded service-test-logs artifact.',
    );
  }
}
// GitHub shows at most ten error annotations per step; prioritize TS failure summaries.
files.sort((a, b) => Number(b.endsWith('/typescript.log')) - Number(a.endsWith('/typescript.log')));
for (const file of files.slice(0, 9)) {
  // The annotation UI truncates long messages from the front, hiding failure summaries.
  // Bound the entire payload before escaping, retaining the actual end of the log.
  const text = stripVTControlCharacters(readFileSync(file, 'utf8')).slice(-3000);
  const escaped = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::error title=Failure diagnostics::${file}%0A${escaped}`);
}
