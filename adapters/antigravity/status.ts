// Antigravity's readings, from its language server: the server that runs a hook, the ports it listens on, and its
// GetUserStatus answer read into a sample. Pure; times in ms.
//
// Antigravity's quotas are each model's (or a group of models'), with the fraction left and when it resets, and no
// window length: a reset within five hours is a 5-hour window, a later one a week. A model once seen on a week stays
// on it, so a week's last five hours are not taken for a 5-hour window.

import type { PaceReading, PaceSample } from '../../types'
import { readingOf } from '../../core/quota.ts'

/** The language server's RPC that answers each model's quota, posted as Connect JSON on loopback */
export const GET_USER_STATUS = '/exa.language_server_pb.LanguageServerService/GetUserStatus'

/** The header that carries the server's CSRF token */
export const CSRF_HEADER = 'x-codeium-csrf-token'

const FIVE_HOURS = 5 * 3600_000
/** A reset this much past five hours is still a 5-hour window: the reading was taken a moment after it opened */
const SLACK = 60_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v)

/** A model's quota key after its prefix: `Gemini 3.1 Pro (High)` → `gemini_3_1_pro`; a variant in brackets is the same quota */
const slugOf = (label: string) => label.replace(/\(.*?\)/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/** A model's name without its variant: `Gemini 3.1 Pro` */
const nameOf = (label: string) => label.replace(/\(.*?\)/g, '').trim()

/** The models a GetUserStatus answer lists; none when it is not one */
function modelsOf(answer: unknown): unknown[] {
  if (!isObject(answer) || !isObject(answer.userStatus)) return []
  const data = answer.userStatus.cascadeModelConfigData
  return isObject(data) && Array.isArray(data.clientModelConfigs) ? data.clientModelConfigs : []
}

/** Each model's reading in a GetUserStatus answer, by quota key; none when it has no quotas */
export function sampleOf(answer: unknown, at: number, known: readonly PaceSample[]): PaceSample | null {
  const weekly = new Set(known.flatMap(s => Object.keys(s.quotas)).filter(k => k.startsWith('seven_day_')))
  const quotas: Record<string, PaceReading> = {}
  for (const m of modelsOf(answer)) {
    if (!isObject(m) || m.disabled === true || typeof m.label !== 'string' || !isObject(m.quotaInfo)) continue
    const resetsAt = Date.parse(String(m.quotaInfo.resetTime))
    if (!Number.isFinite(resetsAt)) continue
    const left = typeof m.quotaInfo.remainingFraction === 'number' ? m.quotaInfo.remainingFraction : 0
    const slug = slugOf(m.label)
    const week = weekly.has(`seven_day_${slug}`) || resetsAt - at > FIVE_HOURS + SLACK
    quotas[`${week ? 'seven_day' : 'five_hour'}_${slug}`] = readingOf((1 - left) * 100, resetsAt, nameOf(m.label))
  }
  return Object.keys(quotas).length ? { at, quotas } : null
}

/**
 * The language server that runs process `pid`, and its CSRF token, from `ps -A -o pid=,ppid=,command=`; null for none.
 * The app runs it as `language_server --csrf_token <token>`; the CLI runs it inside `agy`, whose token comes from
 * `ANTIGRAVITY_CSRF_TOKEN` (`token`, which its hooks inherit) and is in no argument
 */
export function serverOf(ps: string, pid: number, token?: string): { pid: number; csrf: string } | null {
  const procs = new Map<number, { ppid: number; command: string }>()
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), command: m[3]! })
  }
  for (let p = procs.get(pid)?.ppid, hops = 0; p != null && p > 1 && hops < 32; p = procs.get(p)?.ppid, hops++) {
    const command = procs.get(p)?.command ?? ''
    const csrf = /\blanguage_server\b.*--csrf_token(?:=|\s+)(\S+)/.exec(command)?.[1]
    if (csrf) return { pid: p, csrf }
    if (token && /(^|\/)agy(\s|$)/.test(command)) return { pid: p, csrf: token }
  }
  return null
}

/** The TCP ports a process listens on, from `lsof -nP -a -iTCP -sTCP:LISTEN -p <pid> -Fn` */
export function portsOf(lsof: string): number[] {
  return lsof.split('\n').flatMap(line => {
    const m = /^n.*:(\d+)$/.exec(line.trim())
    return m ? [Number(m[1])] : []
  })
}

/** The email a GetUserStatus answer names: the account Antigravity is signed in with; null when it names none */
export function emailOf(answer: unknown): string | null {
  const email = isObject(answer) && isObject(answer.userStatus) ? answer.userStatus.email : undefined
  return typeof email === 'string' && email.includes('@') ? email : null
}
