// claude-code/testing's expect, host-neutral: the matchers the core's tests use, with the same meaning (toEqual
// ignores properties holding undefined). No imports, so it runs on Node and inside Herdr alike.

/** The checks on a value, as claude-code/testing's `expect(received)` offers them */
export type Matchers = {
  toBe: (expected: unknown) => void
  toEqual: (expected: unknown) => void
  toMatchObject: (expected: object) => void
  toContain: (item: unknown) => void
  toMatch: (pattern: RegExp | string) => void
  toBeNull: () => void
  toBeUndefined: () => void
  toBeGreaterThan: (bound: number) => void
  toBeGreaterThanOrEqual: (bound: number) => void
  toBeLessThan: (bound: number) => void
  toBeLessThanOrEqual: (bound: number) => void
}

/** Checks a value: each matcher throws an ExpectationError naming both sides when it fails; `.not` negates */
export function expect(received: unknown, message?: string): Matchers & { not: Matchers } {
  return { ...matchers(received, false, message), not: matchers(received, true, message) }
}

/** What each matcher checks, as a pass or a fail, and the expected side its failure shows */
type Check = (received: unknown, expected: unknown) => boolean

const checks: Record<keyof Matchers, Check> = {
  toBe: (received, expected) => Object.is(received, expected),
  toEqual: (received, expected) => equals(received, expected),
  toMatchObject: (received, expected) => matchesObject(received, expected),
  toContain: (received, item) => contains(received, item),
  toMatch: (received, pattern) =>
    typeof received === 'string' && (pattern instanceof RegExp ? pattern.test(received) : received.includes(String(pattern))),
  toBeNull: (received) => received === null,
  toBeUndefined: (received) => received === undefined,
  toBeGreaterThan: (received, bound) => (received as number) > (bound as number),
  toBeGreaterThanOrEqual: (received, bound) => (received as number) >= (bound as number),
  toBeLessThan: (received, bound) => (received as number) < (bound as number),
  toBeLessThanOrEqual: (received, bound) => (received as number) <= (bound as number),
}

function matchers(received: unknown, negated: boolean, message: string | undefined): Matchers {
  const entries = Object.entries(checks).map(([name, check]) => [
    name,
    (expected?: unknown) => {
      if (check(received, expected) !== negated) return
      const lead = message ? `${message}\n\n` : ''
      throw new ExpectationError(`${lead}expect(received).${negated ? 'not.' : ''}${name}(expected)\n\n` +
        `Expected: ${negated ? 'not ' : ''}${show(expected)}\nReceived: ${show(received)}`)
    },
  ])
  return Object.fromEntries(entries) as Matchers
}

/** A failed check: what was expected and what was received */
export class ExpectationError extends Error {
  override name = 'ExpectationError'
}

/** A value as a failure shows it: `{ a: 1, b: [ 'x' ] }` */
function show(value: unknown, depth = 0): string {
  if (typeof value === 'string') return depth === 0 ? JSON.stringify(value) : `'${value}'`
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (!isObject(value)) return String(value)
  if (depth > 6) return Array.isArray(value) ? '[Array]' : '[Object]'
  if (value instanceof RegExp || value instanceof Date) return String(value)
  if (Array.isArray(value)) return value.length ? `[ ${value.map((item) => show(item, depth + 1)).join(', ')} ]` : '[]'
  const entries = Object.entries(value).map(([key, item]) => `${key}: ${show(item, depth + 1)}`)
  return entries.length ? `{ ${entries.join(', ')} }` : '{}'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Equal in structure: arrays element by element, objects by the keys that hold something, the rest by Object.is */
function equals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!isObject(a) || !isObject(b)) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b)
  if (a instanceof Map && b instanceof Map) return equals([...a], [...b])
  if (a instanceof Set && b instanceof Set) return equals([...a], [...b])
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equals(item, b[i]))
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((key) => o[key] !== undefined)
  const aKeys = keys(a)
  const bKeys = keys(b)
  return aKeys.length === bKeys.length && aKeys.every((key) => Object.hasOwn(b, key) && equals(a[key], b[key]))
}

/** Received holds at least expected's properties, equal; arrays match element by element at the same length */
function matchesObject(received: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(received) && received.length === expected.length &&
      expected.every((item, i) => matchesObject(received[i], item))
  }
  if (isObject(expected) && Object.getPrototypeOf(expected) === Object.prototype) {
    return isObject(received) &&
      Object.keys(expected).every((key) => key in received && matchesObject(received[key], expected[key]))
  }
  return equals(received, expected)
}

/** A string includes the item, or an iterable has an element that is it */
function contains(received: unknown, item: unknown): boolean {
  if (typeof received === 'string') return received.includes(String(item))
  if (isObject(received) && Symbol.iterator in received) {
    return [...(received as Iterable<unknown>)].some((element) => element === item)
  }
  return false
}
