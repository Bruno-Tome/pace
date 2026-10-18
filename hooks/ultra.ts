// Ultra pace, as decisions: auto mode given a goal instead of a checklist. Pure; times in ms.
//
// The agent owns the plan: it writes the steps, works them, reviews them against the goal, and stops only once the
// goal's check passes (or, with no check, once each *Done when* line is verified). On top, the gear spends the quota
// at the pace it allows. Auto mode keeps what it already owns: an interrupt, a block, the turn cap, holds, waits and
// handoffs.

import type { PaceGear, PaceUltra } from '../types'
import { decide, HANDOFF_FILE, markerOf, pacingNote, type Decision, type DecideInput } from './auto.ts'
import type { Step } from './plan.ts'
import { gearFor, headroomOf } from './throttle.ts'

/** Work turns between reviews of the plan against the goal */
export const REVIEW_EVERY = 5
/** Failed checks in a row, and reviews in a row with no new tick, before the run stops */
const CHECK_FAILS = 3
const QUIET_REVIEWS = 3
/** How long pace waits on subagents out on a fan-out before checking in, in case one hung without reporting */
const FANOUT_CHECK = 15 * 60_000
/** Where a subagent out on a fan-out writes its report */
export const FANOUT_DIR = '.pace/fanout'

/**
 * `effort`: the effort the user runs at; `ticked`: whether the turn ticked a step; `lock`: the ticked steps it
 * unlocked (`lockBroken`); `check`: the goal check's result, when the last decision asked for it
 */
export type UltraInput = DecideInput & {
  effort: PaceGear['effort']
  ticked: boolean
  lock: readonly string[]
  check?: { ok: boolean; tail: string }
  steps?: readonly Step[]
  agentsDone?: boolean
}

/** What ultra pace does next, and its state to carry; `check`: run the goal's check and decide again with the result */
export type UltraDecision = (Decision | { kind: 'check'; command: string } | { kind: 'fanout'; steps: string[] }) & { ultra: PaceUltra }

export const planPrompt = (plan: string) =>
  `Read the goal in ${plan} and write the steps that reach it under ## Steps, following pace's ultra pace instructions. Log the plan under ## Revisions. No production code this turn.`

export const workPrompt = (plan: string) => `Work toward the goal in ${plan}: take its next unfinished step, red first, and tick it once it holds.`

export const reviewPrompt = (plan: string, reason: string, tail?: string) =>
  `Review the plan in ${plan} against its goal: ${reason}. Add, split, drop or reorder steps, and log each change under ## Revisions.` +
  (tail ? `\n\nThe end of the check's output:\n\`\`\`\n${tail}\n\`\`\`` : '')

export const integratePrompt = (plan: string, steps: readonly string[]) =>
  `Integrate the subagents' work on ${steps.map(s => `"${s}"`).join(', ')} from ${plan}: read each report in ${FANOUT_DIR}/, run the suite, tick the steps that hold and reopen what does not.`

export const verifyPrompt = (plan: string) =>
  `Verify the goal in ${plan}: check each Done when line against the code and give the evidence for it. End with PACE: GOAL if every line holds; otherwise add the steps that are missing.`

/** What ultra pace does after a turn, after a hold, or once the goal's check has run */
export function decideUltra(i: UltraInput): UltraDecision {
  const u = i.auto.ultra!
  const plan = i.auto.plan
  const marker = markerOf(i.answer)
  const claimed = marker.kind === 'goal' || marker.kind === 'done'
  const ticked = i.ticked
  // A hold or a wait ending decides with no turn behind it
  const turnRan = i.answer.trim() !== ''
  let ultra: PaceUltra = { ...u, quietReviews: ticked ? 0 : u.quietReviews, sinceReview: u.sinceReview + (u.phase === 'work' && turnRan ? 1 : 0) }
  const stop = (why: string): UltraDecision => ({ kind: 'stop', why, ultra })

  if (i.aborted) return { ...decide(i), ultra: u }
  if (marker.kind === 'blocked') return { ...decide(i), ultra: u }
  // Each subagent ending starts a turn: nothing to prompt until the last of them has reported
  if (u.phase === 'fanout' && !i.agentsDone) {
    const n = u.fanout?.agentIds.length ?? 0
    return { kind: 'wait', until: i.snap.at + FANOUT_CHECK, why: `Waiting on ${n} subagent${n === 1 ? '' : 's'}`, stalls: i.auto.stalls ?? 0, ultra: u }
  }

  // The check is a local command: it costs no quota, so it runs before any hold
  let review: { reason: string; tail?: string } | null = u.due ?? null
  ultra = withoutDue(ultra)
  if (i.check) {
    if (i.check.ok) return stop(`Goal reached: ${u.goal}`)
    ultra = { ...ultra, checkFails: u.checkFails + 1 }
    if (ultra.checkFails >= CHECK_FAILS) return stop(`The goal's check failed ${CHECK_FAILS} times in a row: ${lastLine(i.check.tail)}`)
    review = { reason: 'the goal\'s check failed', tail: i.check.tail }
  } else if (claimed) {
    if (u.check) return { kind: 'check', command: u.check, ultra: u }
    if (u.phase === 'verify') return stop(`Goal verified: ${u.goal}`)
  }

  if (!review && i.lock.length) review = { reason: `ticked steps changed with no revision logged (${i.lock.join('; ')}): restore them, or log why under ## Revisions` }
  if (!review && marker.kind === 'replan') review = { reason: marker.reason ?? 'the last turn asked for one' }
  if (!review && i.progressed === false) review = { reason: 'the last turn made no progress' }
  if (!review && ultra.sinceReview >= REVIEW_EVERY) review = { reason: `${REVIEW_EVERY} steps since the last review` }

  // Auto mode's own rules, on an answer whose ultra pace markers it would misread
  const base = decide({ ...i, answer: claimed || marker.kind === 'replan' ? '' : i.answer })
  if (base.kind === 'stop' && i.auto.turns >= i.auto.max) return stop(`Reached ${i.auto.max} turns: /pace ultra resume for more`)
  // A review owed is carried until pace prompts again
  if (base.kind !== 'continue' && base.kind !== 'handoff') return { ...base, ultra: review ? { ...ultra, due: review } : ultra }

  let phase: PaceUltra['phase']
  let prompt: string
  if (review) {
    if (!ticked && ultra.quietReviews + 1 >= QUIET_REVIEWS) return stop(`${QUIET_REVIEWS} reviews in a row with no new step done: the plan is stuck`)
    ultra = { ...ultra, sinceReview: 0, quietReviews: ticked ? 0 : ultra.quietReviews + 1 }
    phase = 'review'
    prompt = reviewPrompt(plan, review.reason, review.tail)
  } else if (u.phase === 'fanout') {
    const { fanout: _, ...rest } = ultra
    ultra = rest
    phase = 'integrate'
    prompt = integratePrompt(plan, u.fanout?.steps ?? [])
  } else if (claimed) {
    phase = 'verify'
    prompt = verifyPrompt(plan)
  } else {
    phase = 'work'
    prompt = workPrompt(plan)
  }

  const cold = base.kind === 'handoff' || !i.snap.cache || i.snap.cache.secondsLeft === 0
  const bounds = { ...u.models, model: i.model ?? u.models.ceiling, effort: i.effort }
  const { gear, streak } = gearFor(headroomOf(i.snap, i.model), bounds, { gear: u.gear, streak: u.headroomStreak, cold })
  ultra = { ...ultra, phase, gear, headroomStreak: streak }
  // With room to push and a step just done, the parallel steps ahead go to subagents while the main thread waits
  const parallel = (i.steps ?? []).filter(s => s.state !== 'done' && s.parallel).slice(0, gear.subagents).map(s => s.text)
  if (phase === 'work' && base.kind === 'continue' && ticked && gear.fanout && parallel.length) {
    return { kind: 'fanout', steps: parallel, ultra: { ...ultra, phase: 'fanout', fanout: { agentIds: [], steps: parallel } } }
  }
  prompt += pacingNote(i.snap) + gearNote(gear)
  if (base.kind === 'handoff') return { kind: 'handoff', prompt: `Resume from ${HANDOFF_FILE}: it says what is done, what is next and what you need to know. Then: ${prompt}`, stalls: base.stalls, ultra }
  return { kind: 'continue', prompt, stalls: base.stalls, ultra }
}

const lastLine = (tail: string) => tail.trim().split('\n').pop() ?? ''

const withoutDue = ({ due: _, ...u }: PaceUltra): PaceUltra => u

/** What the gear allows in subagents, said in each prompt; the model and effort are set by pace, not asked for */
export function gearNote(g: PaceGear): string {
  const who = `${g.subagents} subagent${g.subagents === 1 ? '' : 's'} on ${g.subagentModel}`
  const use = g.subagents > 1 ? 'delegate searches, reads and independent steps' : 'keep it to searches and reads, the rest inline'
  return ` Pace allows ${who}: ${use}.`
}

/** The prompt for a subagent out on a fan-out: one step, its own files, a report instead of a tick */
export const fanoutPrompt = (goal: string, step: string, n: number) =>
  [
    `You are one of several subagents working toward this goal: ${goal}`,
    `Your step, and only this step: ${step}`,
    '- Touch only the files this step needs: other subagents are working beside you on steps of their own.',
    '- Red first: write the failing test, see it fail for the right reason, then make it pass.',
    '- Do not tick the plan or edit it: the main thread integrates your work and ticks it.',
    `- When done, write a report to ${FANOUT_DIR}/${n}.md: what you changed, the files, the tests and their result, and anything left open.`,
  ].join('\n')

/** Ultra pace's instructions, a system-prompt section while it runs: fixed text, so the prompt cache keeps it */
export function ultraProtocol(): string {
  return [
    '# Ultra pace (pace)',
    'You are working toward a goal with no one at the keyboard. The goal is under ## Goal in the plan file; you own the plan under ## Steps. pace sends the next prompt after each turn and says what it is for: planning, one step of work, a review, integrating subagents\' work, or verifying the goal.',
    '- Do what the prompt asks, then stop. A step of work is one step, red first; tick it in the plan file once it holds.',
    '- Revise the plan freely: add, split, drop or reorder steps. Log every change as one line under ## Revisions: the turn, what changed and why.',
    '- A ticked step is locked. Unticking, rewording or removing one needs its own line under ## Revisions, or pace asks for a review to restore it.',
    '- Mark a step `(parallel)` when it does not depend on its neighbours and touches its own files: pace may hand it to a subagent.',
    '- Never wait for the user. Where you would ask, take the recommended option and say which you took.',
    '- When you hand the user a task or need their feedback (a decision only they can make, a credential, an action on their machine or an account), end the turn with `PACE: BLOCKED <what you need>`: pace stops and tells them. Never end a turn on a question.',
    `- Before ending each turn, update ${HANDOFF_FILE}: the goal, what is done, what is next, and the facts a fresh session needs. pace may clear the context and resume from it.`,
    '- Never poll background work. When the next step waits on it, end the turn with `PACE: WAITING <what>`.',
    '- When you believe every Done when line holds, end with `PACE: GOAL`: pace runs the goal\'s check itself, and a failure comes back as a review with its output.',
    '- Before ending a turn with `PACE: BLOCKED`, or once pace says the goal is reached, write a closing report for the user, who was away: **What got done**; **Why it stopped**; **What needs you** (each thing only the user can do, with its reason and urgency, or "Nothing"); **How to do it**; **The plan now**.',
    '- End every turn with exactly one line: `PACE: NEXT` to go on, `PACE: WAITING <what>` while background work runs, `PACE: REPLAN <why>` when the plan needs rethinking, `PACE: GOAL` when the goal is met, or `PACE: BLOCKED <reason>` when you cannot go on without the user.',
  ].join('\n')
}
