/**
 * Qbit suite runner (A2's zero-dependency harness).
 *
 * Compiles src/main/qbit + tests/qbit to CJS with tsc --strict into a temp
 * dir, imports every suite (they register into the shared harness queue),
 * then calls runAll() once. Non-zero exit code on failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const outDir = mkdtempSync(join(tmpdir(), 'vr-qbit-tests-'));

const testFiles = [
  'tests/qbit/auth.test.ts',
  'tests/qbit/version.test.ts',
  'tests/qbit/inspect.test.ts',
  'tests/qbit/commit.test.ts',
  'tests/qbit/progress.test.ts',
  'tests/qbit/lifecycle.test.ts',
];

writeFileSync(
  join(outDir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      module: 'commonjs',
      target: 'es2022',
      moduleResolution: 'node',
      esModuleInterop: true,
      skipLibCheck: true,
      strict: true,
      lib: ['es2022', 'dom'],
      outDir: 'out',
      rootDir: repo,
    },
    include: [
      join(repo, 'src/main/qbit/**/*.ts').replace(/\\/g, '/'),
      ...testFiles.map((f) => join(repo, f).replace(/\\/g, '/')),
    ],
  }),
);

execFileSync(
  process.execPath,
  [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(outDir, 'tsconfig.json')],
  { stdio: 'inherit' },
);

for (const file of testFiles) {
  const compiled = join(
    outDir,
    'out',
    'tests',
    'qbit',
    file.split('/').pop().replace(/\.ts$/, '.js'),
  );
  await import(pathToFileURL(compiled).href);
}

const harness = await import(
  pathToFileURL(join(outDir, 'out', 'tests', 'qbit', 'harness.js')).href
);
await harness.runAll();

const total = globalThis.__vrTestTotal ?? 0;
const failed = globalThis.__vrTestFailed ?? 0;
console.log(`qbit harness: ${total - failed}/${total} passed, ${failed} failed`);

rmSync(outDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
