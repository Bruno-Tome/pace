/** One quota's reading: percent used 0–100, when its window resets (ms), the model's name for a model's own week */
export type PaceReading = { percent: number; resetsAt?: number; name?: string }
/** The readings taken at one moment (ms), by quota key: `five_hour`, `seven_day`, `seven_day_<model>` */
export type PaceSample = { at: number; quotas: Record<string, PaceReading> }

/** Dollars one session (`id`, its own) spent in the minute from `t` (ms), or with `h` in the hour from it, on model `m` where known */
export type PaceSpend = { t: number; id: string; usd: number; h?: true; m?: string }

/** How long the prompt cache stays warm after a reply */
export type PaceCacheTtl = '5m' | '1h'
/** The main thread's last reply: when it landed (ms), the context it left in tokens, the window, the cache's TTL */
export type PaceCacheInfo = { at: number; tokens: number; window: number; ttl: PaceCacheTtl }

/** Warm mode: off, compact the conversation, or ping the cache through a fork, before an idle cache lapses */
export type PaceWarmMode = 'off' | 'compact' | 'ping'

/**
 * Auto mode's run: the plan file, the turns taken and allowed; while it holds or waits, until when and why; and the
 * turns in a row that made no progress; `burst`: never hold for pacing, only for a quota gassed out
 */
export type PaceAuto = { plan: string; turns: number; max: number; heldUntil?: number; waitingUntil?: number; why?: string; paused?: boolean; stalls?: number; burst?: true; ultra?: PaceUltra }

/** How hard ultra pace drives: the main thread's model and effort, how many subagents on which model, fan-out on */
export type PaceGear = {
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  subagents: number
  subagentModel: string
  fanout: boolean
}

/**
 * Ultra pace on top of an auto mode run: a goal instead of a checklist, worked until `check` passes (or, with no
 * check, until the goal is verified). `sinceReview`: work turns since the last review; `quietReviews`: reviews in a
 * row with no new tick; `checkFails`: failed checks in a row; `models`: the user's bounds on the gear's model;
 * `headroomStreak`: decisions in a row the headroom has pointed away from the gear; `fanout`: subagents out on
 * `(parallel)` steps; `due`: a review owed while auto mode holds or waits, with the check's output when it failed
 */
export type PaceUltra = {
  goal: string
  check: string | null
  phase: 'plan' | 'work' | 'fanout' | 'integrate' | 'review' | 'verify'
  sinceReview: number
  quietReviews: number
  checkFails: number
  models: { floor: string; ceiling: string }
  gear: PaceGear
  headroomStreak: number
  fanout?: { agentIds: string[]; steps: string[] }
  due?: { reason: string; tail?: string }
}

/**
 * What is shown (the band above the prompt, the status-line entry), warm mode, on pace mode (keeps a long-running
 * session's context and cache in shape), auto mode's run and whether its onboarding was accepted
 */
export type PacePrefs = { band: boolean; line: boolean; warm?: PaceWarmMode; onPace?: boolean; auto?: PaceAuto | null; onboarded?: boolean }

/** A quota against the clock; `gassedOut` is spent until it resets */
export type PaceStatus = 'early' | 'under' | 'onPace' | 'over' | 'gassedOut'

/** The prompting rate against a quota: `burst` runs it out early if it keeps up; `fast` does and it is over pace */
export type PaceRateLevel = 'idle' | 'ok' | 'brisk' | 'burst' | 'fast'

/** One quota as `$.pace.snapshot()` reports it */
export type PaceQuota = {
  key: string
  /** `5-hour window`, `Week · Fable` */
  name: string
  /** Percent used, 0–100; null without a reading */
  percent: number | null
  /** Null where the reading cannot be set against the clock (stale, no reset time) */
  status: PaceStatus | null
  resetsAt: number | null
  /** When it runs out at its average rate, if before the reset */
  runOutAt: number | null
  rate: {
    level: PaceRateLevel
    promptsPerHour: number
    /** Dollars an hour every local session spends, once the shared spend prices this quota */
    usdPerHour: number | null
    usdBudgetPerHour: number | null
    /** Points of this quota an hour at the current rate, and the points an hour that land it at 100% on reset */
    percentPerHour: number | null
    percentBudgetPerHour: number | null
    /** Percent used at the reset if the rate keeps up, past 100 where it runs out first */
    percentAtReset: number | null
    /** Percent of the quota one prompt costs */
    costPerPrompt: number | null
    /** Seconds until it runs out at the current rate */
    emptyIn: number | null
  }
}

/** Everything pace knows at one moment: what the band, the pane and the window draw */
export type PaceSnapshot = {
  at: number
  /** The 5-hour window first, then the weeks */
  quotas: PaceQuota[]
  /** The prompt cache, null before a reply and after /clear or a compaction */
  cache: {
    tokens: number
    window: number
    ttl: PaceCacheTtl
    secondsLeft: number
    /** The next prompt's context in input-token equivalents, warm and cold, and in dollars once priced */
    nextWarm: number
    nextCold: number
    nextWarmUsd: number | null
    nextColdUsd: number | null
  } | null
  spend: { usdPerHour: number; sessions: number; usdPerPrompt: number | null }
  /** A quota is spent: prompts fail until it resets */
  gassedOut: boolean
  /** On pace mode, and auto mode's run while one is going */
  modes: { onPace: boolean; auto: PaceAuto | null }
  /** What would cut token usage now, most urgent first */
  advice: { level: 'urgent' | 'warn' | 'info'; text: string }[]
}

/** `$.pace`: pace's data for other plugins, read-only */
export type Pace = {
  snapshot: () => Promise<PaceSnapshot>
}

declare module 'claude-code' {
  interface EngineInterface {
    pace: Pace
  }
  interface PluginState {
    pace: {
      samples: PaceSample[]
      /** Prompt submission times (ms) from every local session, the last day */
      prompts: number[]
      /** The same prompts by the model they went to, where it was known */
      modelPrompts: Record<string, number[]>
      prefs: PacePrefs
      /** The last reply's context, null before one and after /clear or a compaction */
      cache: PaceCacheInfo | null
      /** The last replies' dollars per input-token equivalent, which price the next prompt */
      prices: number[]
      /** What every local session spent, shared through the store */
      spend: PaceSpend[]
      /** The cache TTL a model switch last reported */
      ttl: PaceCacheTtl
      /** The minute clock the drawings read, so elapsed time moves without a new sample */
      now: number
    }
  }
}
