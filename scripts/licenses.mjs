import { readFile, readdir, writeFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [
  'Pi ACP Workbench — bundled third-party dependencies\nThe extension itself is licensed under MIT (see LICENSE).\n',
];
for (const [location, info] of Object.entries(lock.packages).sort(([a], [b]) =>
  a < b ? -1 : a > b ? 1 : 0,
)) {
  if (!location || info.dev) continue;
  const pkg = JSON.parse(await readFile(`${location}/package.json`, 'utf8'));
  notices.push(
    `\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${pkg.license || info.license || 'See upstream'}\n`,
  );
  const files = (await readdir(location))
    .filter((f) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f))
    .sort();
  for (const file of files) {
    try {
      notices.push(await readFile(`${location}/${file}`, 'utf8'));
    } catch {
      /* directories are not license text */
    }
  }
}
const output = notices
  .join('\n')
  .replace(/\r\n/g, '\n')
  .replace(/[ \t]+$/gm, '');
const file = 'THIRD_PARTY_NOTICES.txt';
const previous = await readFile(file, 'utf8').catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
if (output !== previous) await writeFile(file, output);
