// What pi needs of pace beyond the core's API (core/api.ts): its thinking levels, which on pace mode lowers. Pure.

/** pi's thinking levels above off, lightest first */
export const PI_THINKING = ['minimal', 'low', 'medium', 'high', 'xhigh']
const THINKING = PI_THINKING

/**
 * On pace mode's thinking level for a turn: one step lower while the rate would gas a quota out (`runsOut` in
 * core/auto.ts, which owns that rule for every host), never below minimal; off and a level pi has not named stay
 */
export function thinkingFor(level: string, runsOut: boolean): string {
  const i = THINKING.indexOf(level)
  return runsOut && i > 0 ? THINKING[i - 1]! : level
}
