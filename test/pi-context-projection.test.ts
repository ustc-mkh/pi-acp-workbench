import { it, expect } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
  utimesSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { projectContext } from '../src/pi-context-projection';
const owner = 'a'.repeat(64);
async function fixture(run: (file: string, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'context-projection-'));
  try {
    await run(join(root, 'models.json'), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const get = (file: string) =>
  JSON.parse(readFileSync(file, 'utf8')).providers?.p?.modelOverrides?.m?.contextWindow;
it('holds a canonical profile lock through refresh and fences old revisions/other roots', () =>
  fixture(async (file, root) => {
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          p: { apiKey: 'fixture-only', modelOverrides: { other: { contextWindow: 99 } } },
        },
      }),
    );
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (entered = r));
    const first = projectContext(file, 'p/m', 100, { owner, revision: 1 }, async () => {
      entered();
      await gate;
    });
    await ready;
    symlinkSync(root, join(root, 'alias'), 'dir');
    await expect(
      projectContext(
        join(root, 'alias/models.json'),
        'p/m',
        200,
        { owner, revision: 2 },
        async () => {},
      ),
    ).rejects.toThrow();
    release();
    await first;
    await projectContext(file, 'p/m', 200, { owner, revision: 2 }, async () => {});
    const after = readFileSync(file, 'utf8');
    await expect(
      projectContext(file, 'p/m', 100, { owner, revision: 1 }, async () => {}),
    ).rejects.toThrow('过期');
    await expect(
      projectContext(file, 'p/m', 300, { owner: 'b'.repeat(64), revision: 3 }, async () => {}),
    ).rejects.toThrow('另一个');
    expect(readFileSync(file, 'utf8')).toBe(after);
    expect(get(file)).toBe(200);
    expect(JSON.parse(after).providers.p.apiKey).toBe('fixture-only');
    expect(JSON.parse(after).providers.p.modelOverrides.other.contextWindow).toBe(99);
  }));
it('recovers prepared/applied checkpoints without rewriting models.json and detects external target changes', () =>
  fixture(async (file) => {
    await expect(
      projectContext(file, 'p/m', 500, { owner, revision: 1 }, async () => {
        throw new Error('refresh interrupted');
      }),
    ).rejects.toThrow('interrupted');
    expect(get(file)).toBe(500);
    expect(JSON.parse(readFileSync(file + '.workbench-context.json', 'utf8')).state).toBe(
      'prepared',
    );
    const before = statSync(file).mtimeMs;
    await projectContext(file, 'p/m', 500, { owner, revision: 1 }, async () => {});
    expect(statSync(file).mtimeMs).toBe(before);
    await projectContext(file, 'p/m', 500, { owner, revision: 1 }, async () => {});
    expect(statSync(file).mtimeMs).toBe(before);
    const changed = JSON.parse(readFileSync(file, 'utf8'));
    changed.providers.p.modelOverrides.m.contextWindow = 700;
    writeFileSync(file, JSON.stringify(changed));
    await expect(
      projectContext(file, 'p/m', 500, { owner, revision: 1 }, async () => {}),
    ).rejects.toThrow('外部修改');
    expect(get(file)).toBe(700);
    await projectContext(file, 'p/m', 800, { owner, revision: 2 }, async () => {});
    expect(get(file)).toBe(800);
  }));
it('rejects a refresh-time external edit and a late busy worker without acknowledging success', () =>
  fixture(async (file) => {
    await expect(
      projectContext(file, 'p/m', 100, { owner, revision: 1 }, async () => {
        const x = JSON.parse(readFileSync(file, 'utf8'));
        x.providers.p.modelOverrides.m.contextWindow = 200;
        writeFileSync(file, JSON.stringify(x));
      }),
    ).rejects.toThrow('刷新期间');
    const before = readFileSync(file, 'utf8');
    await expect(
      projectContext(
        file,
        'p/m',
        300,
        { owner, revision: 2 },
        async () => {},
        () => false,
      ),
    ).rejects.toThrow('开始运行');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(file + '.workbench-context.json', 'utf8')).state).toBe(
      'prepared',
    );
  }));
it('recovers after real SIGKILL between file publication and refresh confirmation', () =>
  fixture(async (file, root) => {
    const bundled = await build({
      entryPoints: ['src/pi-context-projection.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    const module = join(root, 'projection.mjs');
    writeFileSync(module, bundled.outputFiles[0].text);
    const marker = join(root, 'published');
    const script = `import {projectContext} from ${JSON.stringify(pathToFileURL(module).href)};import{writeFileSync}from'node:fs';await projectContext(${JSON.stringify(file)},'p/m',1024,{owner:${JSON.stringify(owner)},revision:1},async()=>{writeFileSync(${JSON.stringify(marker)},'published');await new Promise(()=>{setInterval(()=>{},1000);});});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (x) => (errors += x));
    const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(marker)) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error('child did not publish: ' + errors);
        await new Promise((r) => setTimeout(r, 10));
      }
      child.kill('SIGKILL');
      expect((await done).signal).toBe('SIGKILL');
      expect(get(file)).toBe(1024);
      const before = readFileSync(file, 'utf8'),
        time = statSync(file).mtimeMs;
      // Advance only the dead test process's orphan lock past the normal stale timeout.
      const old = new Date(Date.now() - 60000);
      utimesSync(file + '.lock', old, old);
      await projectContext(file, 'p/m', 1024, { owner, revision: 1 }, async () => {});
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(statSync(file).mtimeMs).toBe(time);
      expect(JSON.parse(readFileSync(file + '.workbench-context.json', 'utf8')).state).toBe(
        'applied',
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    }
  }));

it('updates a symlink target under its canonical lock without replacing the symlink', () =>
  fixture(async (file, root) => {
    const target = join(root, 'actual-models.json');
    writeFileSync(target, '{}');
    symlinkSync(target, file);
    await projectContext(file, 'p/m', 123, { owner, revision: 1 }, async () => {});
    expect(get(target)).toBe(123);
    expect((await import('node:fs')).lstatSync(file).isSymbolicLink()).toBe(true);
  }));
