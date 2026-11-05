import { describe, expect, test } from 'claude-code/testing'
import { plainText, plansFor, route, stepOf, viewLines, warmStep, type Host, type WarmStepInput } from '../core/api.ts'
import type { PaceFeed } from '../core/host.ts'
import { snapshotOf } from '../core/model.ts'
import { commandOf } from '../core/command.ts'
import { clockAt } from '../core/quota.ts'

const H = 3600_000
const NOW = Date.UTC(2026, 10, 5, 12)

// Each host as it declares itself: its surfaces in the order it prefers them, and what it can do to its agent
const claude: Host = { name: 'Claude Code', input: 'prompt', surfaces: ['split', 'pane', 'window', 'band', 'status', 'toast'], drives: ['prompt', 'compact', 'clear', 'effort', 'model', 'ping'], cache: true }
const codex: Host = { name: 'Codex', input: 'prompt', surfaces: ['split', 'answer', 'window'], drives: ['prompt'], cache: false, holdUpTo: 9 * 60_000 }
const pi: Host = { name: 'pi', input: 'editor', surfaces: ['overlay', 'split', 'band', 'status', 'toast'], drives: ['prompt', 'compact', 'effort'], cache: true }
const agy: Host = { name: 'Antigravity', input: 'prompt', surfaces: ['window', 'toast'], drives: [], cache: false }
const inHerdr = (h: Host): Host => ({ ...h, surfaces: ['herdr', ...h.surfaces] })
const noTmux = (h: Host): Host => ({ ...h, surfaces: h.surfaces.filter(s => s !== 'split') })

const r = (args: string, h: Host) => route(commandOf(args), h)

describe('views go to the surface the host prefers', () => {
  test('/pace opens the charts on the first surface that shows them', () => {
    expect(r('', claude)).toEqual({ kind: 'open', view: 'pane', surface: 'split' })
    expect(r('', noTmux(claude))).toEqual({ kind: 'open', view: 'pane', surface: 'pane' })
    expect(r('', pi)).toEqual({ kind: 'open', view: 'pane', surface: 'overlay' })
    expect(r('', noTmux(codex))).toEqual({ kind: 'open', view: 'pane', surface: 'answer' })
    expect(r('', agy)).toEqual({ kind: 'open', view: 'pane', surface: 'window' })
  })

  test('in Herdr every view opens there first, the host\'s own surface as the fallback', () => {
    expect(r('', inHerdr(pi))).toEqual({ kind: 'open', view: 'pane', surface: 'herdr', fallback: { kind: 'open', view: 'pane', surface: 'overlay' } })
    expect(r('window', inHerdr(codex))).toEqual({ kind: 'open', view: 'pane', surface: 'herdr', fallback: { kind: 'open', view: 'pane', surface: 'window' } })
    const band = { kind: 'say', text: 'The band is above the prompt; /pace hide hides it, and in Herdr /pace band opens it under the session' }
    expect(r('band', inHerdr(claude))).toEqual({ kind: 'open', view: 'band', surface: 'herdr', fallback: band })
    expect(r('fleet', inHerdr(agy))).toEqual({ kind: 'open', view: 'fleet', surface: 'herdr', fallback: { kind: 'open', view: 'fleet', surface: 'window' } })
  })

  test('the plan never opens in Herdr: it shows no plan', () => {
    expect(r('timeline', inHerdr(pi))).toEqual({ kind: 'open', view: 'plan', surface: 'split', files: [] })
    expect(r('plan a.md b.md', noTmux(pi))).toEqual({ kind: 'open', view: 'plan', surface: 'overlay', files: ['a.md', 'b.md'] })
    expect(r('timeline', noTmux(codex))).toEqual({ kind: 'open', view: 'plan', surface: 'answer', files: [] })
  })

  test('split, pane and window each ask for their surface, and say so when the host has none', () => {
    expect(r('split', codex)).toEqual({ kind: 'open', view: 'pane', surface: 'split' })
    const split = r('split', noTmux(pi))
    expect(split).toEqual({ kind: 'open', view: 'pane', surface: 'overlay', note: 'Not inside tmux; the charts open here' })
    expect(r('pane', claude)).toEqual({ kind: 'open', view: 'pane', surface: 'pane' })
    expect(r('pane', codex)).toEqual({ kind: 'open', view: 'pane', surface: 'answer' })
    expect(r('window', claude)).toEqual({ kind: 'open', view: 'pane', surface: 'window' })
    expect(r('window', pi)).toEqual({ kind: 'open', view: 'pane', surface: 'overlay', note: 'pi has no window of its own; the charts open here' })
  })

  test('the band is said to be in place where the host shows it, and opens beside the others', () => {
    expect(r('band', pi)).toEqual({ kind: 'say', text: 'The band is above the editor; /pace hide hides it, and in Herdr /pace band opens it under the session' })
    expect(r('band', claude)).toEqual({ kind: 'say', text: 'The band is above the prompt; /pace hide hides it, and in Herdr /pace band opens it under the session' })
    expect(r('band', codex)).toEqual({ kind: 'open', view: 'band', surface: 'split' })
    expect(r('band', noTmux(codex))).toEqual({ kind: 'open', view: 'band', surface: 'answer' })
    expect(r('band', agy)).toEqual({ kind: 'open', view: 'band', surface: 'window' })
  })

  test('the fleet opens in the pane pace has, else beside the host', () => {
    expect(r('fleet', claude)).toEqual({ kind: 'open', view: 'fleet', surface: 'pane' })
    expect(r('fleet', pi)).toEqual({ kind: 'open', view: 'fleet', surface: 'overlay' })
    expect(r('fleet', codex)).toEqual({ kind: 'open', view: 'fleet', surface: 'split' })
  })
})

describe('what drives the agent goes where the host can carry it out', () => {
  test('auto mode runs where the host can send a prompt', () => {
    expect(r('auto', codex)).toEqual({ kind: 'auto', plan: 'ROADMAP.md', max: 40 })
    expect(r('auto off', pi)).toEqual({ kind: 'stop', ultra: false, text: 'Auto mode off' })
    expect(r('auto resume', codex)).toEqual({ kind: 'resume' })
    expect(r('auto burst', pi)).toEqual({ kind: 'burst', on: true })
    expect(r('auto', agy)).toEqual({ kind: 'say', text: 'Auto mode is not in Antigravity: pace cannot send it a prompt' })
  })

  test('ultra pace runs where the host can change the model or its thinking (ADR 0021); its gears climb the host\'s ladder', () => {
    expect(r('ultra PLAN.md 20 mini..sol', pi)).toEqual({ kind: 'ultra', plan: 'PLAN.md', max: 20, floor: 'mini', ceiling: 'sol' })
    expect(r('ultra off', pi)).toEqual({ kind: 'stop', ultra: true, text: 'Ultra pace off' })
  })

  test('ultra pace runs where the host can change the model', () => {
    expect(r('ultra', claude)).toEqual({ kind: 'ultra', plan: 'ROADMAP.md', max: 80 })
    expect(r('ultra preview', claude)).toEqual({ kind: 'preview' })
    expect(r('ultra', codex)).toEqual({ kind: 'say', text: 'Ultra pace is not in Codex: it changes the model and the effort turn by turn, and pace cannot change them there' })
    expect(r('ultra off', agy)).toEqual({ kind: 'say', text: 'Ultra pace is not in Antigravity: it changes the model and the effort turn by turn, and pace cannot change them there' })
  })

  test('on pace mode needs a host that can compact or lower the effort', () => {
    expect(r('on', pi)).toEqual({ kind: 'prefs', prefs: { onPace: true }, text: 'On pace mode on: compacts a heavy context while its cache is warm, keeps a large idle cache warm, and lowers the effort while the rate would gas a quota out' })
    expect(r('off', claude)).toEqual({ kind: 'prefs', prefs: { onPace: false }, text: 'On pace mode off' })
    expect(r('on', codex)).toEqual({ kind: 'say', text: 'On pace mode is not in Codex: pace cannot lower its effort or compact it. pace still warns before a quota gasses out' })
  })

  test('warm mode needs a cache the host reports, and pings only where it can', () => {
    expect(r('warm compact', pi)).toEqual({ kind: 'prefs', prefs: { warm: 'compact' }, text: 'Warm mode compact: with under 10 minutes of cache left and the agent idle, compacts (once until your next prompt)' })
    expect(r('warm ping', pi)).toEqual({ kind: 'say', text: 'pi cannot ping its cache: /pace warm compact keeps it warm by compacting' })
    expect(r('warm ping', claude)).toEqual({ kind: 'prefs', prefs: { warm: 'ping' }, text: 'Warm mode ping: with under 10 minutes of cache left and the agent idle, sends one word to keep it warm (once until your next prompt)' })
    expect(r('warm off', codex)).toEqual({ kind: 'say', text: 'Warm mode is not in Codex: it reports no prompt cache' })
  })

  test('warm mode is said to be missing where the host can neither ping nor compact, never sent in a circle', () => {
    const hermes: Host = { name: 'Hermes', input: 'prompt', surfaces: ['answer'], drives: ['prompt'], cache: true }
    const text = 'Warm mode is not in Hermes: pace cannot ping its cache or compact it'
    expect(r('warm ping', hermes)).toEqual({ kind: 'say', text })
    expect(r('warm compact', hermes)).toEqual({ kind: 'say', text })
  })

  test('a mode is set only where the host keeps it: over ACP nothing keeps on pace mode, so it says so', () => {
    const acp: Host = { name: 'this agent', input: 'prompt', surfaces: ['answer'], drives: ['prompt', 'effort'], cache: false, keeps: [] }
    expect(r('on', acp)).toEqual({ kind: 'say', text: 'On pace mode is not in this agent yet: pace keeps no modes there' })
  })

  test('the band and the status line are preferences where the host shows them', () => {
    expect(r('hide', pi)).toEqual({ kind: 'prefs', prefs: { band: false }, text: 'Pace band hidden; /pace show brings it back' })
    expect(r('line off', claude)).toEqual({ kind: 'prefs', prefs: { line: false }, text: 'Pace status line off' })
    expect(r('show', codex)).toEqual({ kind: 'say', text: 'Codex has no band of its own: /pace band opens one beside it' })
    expect(r('line on', agy)).toEqual({ kind: 'say', text: 'Antigravity has no status line pace can write to' })
  })

  test('refresh, close and errors', () => {
    expect(r('refresh', codex)).toEqual({ kind: 'refresh', text: 'Pace figures refreshed' })
    expect(r('close', claude)).toEqual({ kind: 'close' })
    expect(r('close', pi)).toEqual({ kind: 'say', text: 'Close the pace split with q there' })
    expect(r('nonsense', pi).kind).toBe('say')
  })
})

describe('auto mode\'s decision, as a step the host carries out', () => {
  test('a next prompt is sent; a handoff clears where the host can, else compacts, else just goes on', () => {
    expect(stepOf({ kind: 'continue', prompt: 'next', stalls: 0 }, codex, NOW)).toEqual({ kind: 'send', prompt: 'next' })
    expect(stepOf({ kind: 'handoff', prompt: 'resume', stalls: 0 }, claude, NOW)).toEqual({ kind: 'send', prompt: 'resume', clear: true })
    expect(stepOf({ kind: 'handoff', prompt: 'resume', stalls: 0 }, pi, NOW)).toEqual({ kind: 'send', prompt: 'resume', compact: true })
    expect(stepOf({ kind: 'handoff', prompt: 'resume', stalls: 0 }, codex, NOW)).toEqual({ kind: 'send', prompt: 'resume' })
  })

  test('a hold waits where the host can wait that long, and pauses the run where it cannot', () => {
    // 5 minutes: within Codex's nine
    expect(stepOf({ kind: 'hold', until: NOW + 5 * 60_000, why: 'Over pace' }, codex, NOW)).toEqual({ kind: 'hold', until: NOW + 5 * 60_000, note: `Auto mode holding until ${clockAt(NOW + 5 * 60_000, false)}. Over pace` })
    const long = stepOf({ kind: 'hold', until: NOW + 2 * H, why: 'Over pace' }, codex, NOW)
    expect(long).toEqual({ kind: 'pause', heldUntil: NOW + 2 * H, message: `Auto mode holding until ${clockAt(NOW + 2 * H, false)}. Over pace. Codex cannot wait that long: /pace auto resume picks it up then` })
    expect(stepOf({ kind: 'hold', until: NOW + 2 * H, why: 'Over pace' }, pi, NOW).kind).toBe('hold')
    expect(stepOf({ kind: 'wait', until: NOW + H, why: 'Agents at work', stalls: 0 }, pi, NOW)).toEqual({ kind: 'hold', until: NOW + H, note: `Auto mode sends nothing until ${clockAt(NOW + H, false)} or a turn of its own. Agents at work` })
  })

  test('a pause and a stop say why', () => {
    expect(stepOf({ kind: 'pause', why: 'It asked you' }, pi, NOW)).toEqual({ kind: 'pause', message: 'Auto mode paused. It asked you' })
    expect(stepOf({ kind: 'stop', why: 'Plan done' }, codex, NOW)).toEqual({ kind: 'stop', message: 'Auto mode off. Plan done' })
  })
})

describe('keeping a cache warm, as far as the host can', () => {
  const MIN = 60_000
  // 55 minutes into an hour's cache: under ten minutes left
  const cached = (tokens: number) => ({ at: NOW - 55 * MIN, tokens, window: 272_000, ttl: '1h' as const })
  const input = (tokens: number, over: Partial<WarmStepInput> & Pick<WarmStepInput, 'prefs'>): WarmStepInput => {
    const cache = cached(tokens)
    return { cache, snap: snapshotOf({ samples: [], prompts: [], cache }, NOW), now: NOW, working: false, actions: 0, lastFor: null, ...over }
  }

  test('compacts with under ten minutes of cache left and the agent idle, in warm mode compact or on pace mode on a large context', () => {
    expect(warmStep(input(100_000, { prefs: { onPace: false, warm: 'compact' } }), pi)).toBe('compact')
    expect(warmStep(input(100_000, { prefs: { onPace: true, warm: 'off' } }), pi)).toBe('compact')
  })

  test('pings a small context where the host can, and does nothing where it cannot', () => {
    expect(warmStep(input(60_000, { prefs: { onPace: true, warm: 'off' } }), claude)).toBe('ping')
    expect(warmStep(input(60_000, { prefs: { onPace: true, warm: 'off' } }), pi)).toBeNull()
  })

  test('does nothing with warm mode off, while the agent works, or once already for this reply', () => {
    expect(warmStep(input(100_000, { prefs: { onPace: false, warm: 'off' } }), pi)).toBeNull()
    expect(warmStep(input(100_000, { prefs: { onPace: false, warm: 'compact' }, working: true }), pi)).toBeNull()
    expect(warmStep(input(100_000, { prefs: { onPace: false, warm: 'compact' }, lastFor: NOW - 55 * MIN }), pi)).toBeNull()
  })
})

describe('a view drawn for a surface that shows text', () => {
  const feed: PaceFeed = {
    version: 1, host: 'codex', provider: 'codex', session: 'c1', cwd: '/w', at: NOW,
    snapshot: { samples: [{ at: NOW, quotas: { five_hour: { percent: 40, resetsAt: NOW + 2 * H } } }], prompts: [NOW], cache: null, noCache: true },
  }
  const base = { feed, others: [], plans: [], now: NOW, cols: 90 }

  test('the charts and the band lead with the session, then its quotas', () => {
    const pane = plainText(viewLines('pane', base))
    expect(pane).toContain('5h')
    expect(pane).toContain('40%')
    expect(plainText(viewLines('band', base))).toContain('40%')
  })

  test('the fleet sets every live feed\'s provider side by side', () => {
    const claude: PaceFeed = { ...feed, host: 'claude', provider: 'claude', session: 'k1' }
    const text = plainText(viewLines('fleet', { ...base, others: [claude] }))
    expect(text).toContain('Codex')
    expect(text).toContain('Claude')
  })

  test('the plan shows each plan named with its steps', () => {
    const text = plainText(viewLines('plan', { ...base, plans: [{ plan: 'ROADMAP.md', text: '- [x] one\n- [ ] two' }] }))
    expect(text).toContain('ROADMAP.md')
    expect(text).toContain('two')
  })

  test('the plans a timeline shows: those named, else auto mode\'s, else the roadmap', () => {
    expect(plansFor(feed, ['a.md'])).toEqual(['a.md'])
    expect(plansFor({ ...feed, snapshot: { ...feed.snapshot, auto: { plan: 'P.md', turns: 1, max: 40 } } }, [])).toEqual(['P.md'])
    expect(plansFor(feed, [])).toEqual(['ROADMAP.md'])
  })
})
