// claude-code/testing's describe, test and expect inside Herdr's JS runtime, which has no test runner: tests are
// collected as the files load, then run by the check-only mod that scripts/herdr.ts builds, which fails the check
// with every failure's name and message.

export { expect } from './expect.ts'

/** One test as declared: its full name, the describes around it leading */
type Declared = { name: string; body: () => unknown }

/** A test that failed: its full name and why */
export type Failure = { name: string; message: string }

const declared: Declared[] = []
const groups: string[] = []

/** A group of tests: its name leads the title of each test inside */
export function describe(name: string, body: () => void): void {
  groups.push(name)
  try {
    body()
  } finally {
    groups.pop()
  }
}

/** One test, run later by `run` */
export function test(name: string, body: () => unknown): void {
  declared.push({ name: [...groups, name].join(' > '), body })
}

/** Runs every test declared so far, at once: how many there were, and the ones that failed. A check runs the mod
 * once and waits for nothing, so a test whose body returns a promise fails rather than pass unawaited. */
export function run(): { total: number; failures: Failure[] } {
  const failures: Failure[] = []
  for (const { name, body } of declared) {
    try {
      const result = body()
      if (result instanceof Promise) throw new Error('async tests do not run inside Herdr')
    } catch (error) {
      failures.push({ name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { total: declared.length, failures }
}
