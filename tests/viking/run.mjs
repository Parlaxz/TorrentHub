/**
 * Self-contained test runner for the Viking integration.
 * Compiles src/main/viking + tests/viking to CJS in a temp dir (no repo
 * package.json required), then runs them with the Node built-in test runner.
 *
 * Usage: node tests/viking/run.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(os.tmpdir(), 'opencode', 'viking-build')

function walkTs(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTs(full))
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const sources = [
  ...walkTs(path.join(repoRoot, 'src', 'main', 'viking')),
  ...walkTs(path.join(repoRoot, 'tests', 'viking')),
]

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

console.log('Compiling with tsc...')
const tscArgs = [
  '--strict',
  '--target',
  'es2022',
  '--module',
  'commonjs',
  '--moduleResolution',
  'node',
  '--esModuleInterop',
  '--skipLibCheck',
  '--noEmitOnError',
  '--outDir',
  outDir,
  ...sources,
]
const tsc = spawnSync('tsc', tscArgs, { shell: true, stdio: 'inherit' })
if (tsc.status !== 0) {
  console.error('TypeScript compilation failed')
  process.exit(tsc.status ?? 1)
}

const testDir = path.join(outDir, 'tests', 'viking')
console.log(`Running tests in ${testDir}...`)
const result = spawnSync(process.execPath, ['--test'], { stdio: 'inherit', cwd: testDir })
process.exit(result.status ?? 1)
