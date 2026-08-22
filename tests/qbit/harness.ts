/**
 * Zero-dependency test harness.
 *
 * The repository has no package.json yet (concurrent writers own it), so tests
 * avoid external runners/dependencies entirely. Each *.test.ts file registers
 * and executes tests at import time; run.mjs (generated next to the compiled
 * output) imports all suites and reports a summary with a non-zero exit code
 * on failure.
 */

export type TestFn = () => void | Promise<void>;

interface QueueEntry {
  name: string;
  fn: TestFn;
}

declare global {
  var __vrTestTotal: number | undefined;
  var __vrTestFailed: number | undefined;
}

function bump(kind: 'total' | 'failed'): void {
  if (kind === 'total') globalThis.__vrTestTotal = (globalThis.__vrTestTotal ?? 0) + 1;
  else globalThis.__vrTestFailed = (globalThis.__vrTestFailed ?? 0) + 1;
}

const queue: QueueEntry[] = [];

/** Registers a test. Execution happens later, sequentially, via runAll(). */
export function test(name: string, fn: TestFn): void {
  queue.push({ name, fn });
}

/** Runs every registered test strictly sequentially. */
export async function runAll(): Promise<void> {
  for (const entry of queue) {
    bump('total');
    try {
      await entry.fn();
      console.log(`  ok - ${entry.name}`);
    } catch (err) {
      bump('failed');
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`  NOT OK - ${entry.name}\n      ${message.split('\n').join('\n      ')}`);
    }
  }
}

export function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      `${message ?? 'assertEquals failed'}\n      actual:   ${a}\n      expected: ${e}`,
    );
  }
}

export async function expectThrows(
  fn: () => Promise<unknown> | unknown,
  matchCode?: string,
): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (matchCode) {
      const code = (e as Error & { code?: string }).code;
      if (code !== matchCode) {
        throw new Error(`expected error code ${matchCode}, got ${code ?? '(none)'}: ${e.message}`);
      }
    }
    return e;
  }
  throw new Error(`expected function to throw${matchCode ? ` ${matchCode}` : ''}, but it resolved`);
}
