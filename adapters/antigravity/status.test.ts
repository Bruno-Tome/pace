import { describe, expect, test } from 'claude-code/testing'

import type { PaceSample } from '../../types'
import { emailOf, GET_USER_STATUS, portsOf, sampleOf, serverOf } from './status.ts'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN

const iso = (t: number) => new Date(t).toISOString()

/** GetUserStatus's answer, as the language server sends it: its models, each with its quota */
const status = (models: unknown[]) => ({ userStatus: { name: 'someone', cascadeModelConfigData: { clientModelConfigs: models } } })

const model = (label: string, quotaInfo?: object, over: object = {}) => ({ label, modelOrAlias: { model: 'MODEL_PLACEHOLDER_M7' }, ...(quotaInfo ? { quotaInfo } : {}), ...over })

describe('the language server\'s readings', () => {
  test('are each model\'s use, in percent, with its reset: a reset within five hours is a 5-hour window', () => {
    const s = sampleOf(status([model('Gemini 3.1 Pro (High)', { remainingFraction: 0.6, resetTime: iso(NOW + 2 * H) })]), NOW, [])
    expect(s).toEqual({ at: NOW, quotas: { five_hour_gemini_3_1_pro: { percent: 40, resetsAt: NOW + 2 * H, name: 'Gemini 3.1 Pro' } } })
  })

  test('a reset further off than five hours is a week', () => {
    const s = sampleOf(status([model('Claude Sonnet 4.6 (Thinking)', { remainingFraction: 0.75, resetTime: iso(NOW + 3 * 24 * H) })]), NOW, [])
    expect(s!.quotas).toEqual({ seven_day_claude_sonnet_4_6: { percent: 25, resetsAt: NOW + 3 * 24 * H, name: 'Claude Sonnet 4.6' } })
  })

  test('a quota with no fraction left is spent: proto3 leaves a zero out', () => {
    const s = sampleOf(status([model('Gemini 3 Flash', { resetTime: iso(NOW + H) })]), NOW, [])
    expect(s!.quotas.five_hour_gemini_3_flash!.percent).toBe(100)
  })

  test('a model seen on a week stays on it in its last five hours', () => {
    const week: PaceSample[] = [{ at: NOW - 24 * H, quotas: { seven_day_gemini_3_1_pro: { percent: 70, resetsAt: NOW + H } } }]
    const s = sampleOf(status([model('Gemini 3.1 Pro (Low)', { remainingFraction: 0.1, resetTime: iso(NOW + H) })]), NOW, week)
    expect(Object.keys(s!.quotas)).toEqual(['seven_day_gemini_3_1_pro'])
  })

  test('variants of one model are one quota; a disabled model or one with no quota is left out', () => {
    const s = sampleOf(status([
      model('Gemini 3.1 Pro (High)', { remainingFraction: 0.6, resetTime: iso(NOW + 2 * H) }),
      model('Gemini 3.1 Pro (Low)', { remainingFraction: 0.6, resetTime: iso(NOW + 2 * H) }),
      model('GPT-OSS 120B (Medium)', { remainingFraction: 0.2, resetTime: iso(NOW + 2 * H) }, { disabled: true }),
      model('Gemini 2.5 Flash'),
    ]), NOW, [])
    expect(Object.keys(s!.quotas)).toEqual(['five_hour_gemini_3_1_pro'])
  })

  test('none from an answer that is not GetUserStatus\'s, or that has no quotas', () => {
    expect(sampleOf(null, NOW, [])).toBeNull()
    expect(sampleOf({ code: 'unauthenticated' }, NOW, [])).toBeNull()
    expect(sampleOf(status([model('Gemini 2.5 Flash')]), NOW, [])).toBeNull()
  })

  test('are asked for at the language server\'s own GetUserStatus', () => {
    expect(GET_USER_STATUS).toBe('/exa.language_server_pb.LanguageServerService/GetUserStatus')
  })
})

describe('the language server that runs a hook', () => {
  // `ps -A -o pid=,ppid=,command=`: the hook, the shell Antigravity ran it in, the language server, the app
  const ps = [
    '  1 0 /sbin/launchd',
    '  900 1 /Applications/Antigravity.app/Contents/MacOS/Antigravity',
    '  950 900 /Applications/Antigravity.app/Contents/Resources/bin/language_server --enable_lsp --csrf_token=0f3c-41aa --random_port --app_data_dir antigravity',
    '  951 900 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token other',
    ' 1200 950 sh -c node /work/pace/adapters/antigravity/hook.ts PreInvocation',
    ' 1201 1200 node /work/pace/adapters/antigravity/hook.ts PreInvocation',
  ].join('\n')

  test('is the hook\'s ancestor, with the CSRF token it was started with', () => {
    expect(serverOf(ps, 1201)).toEqual({ pid: 950, csrf: '0f3c-41aa' })
  })

  test('takes the token as one argument or two', () => {
    expect(serverOf('5 1 /x/language_server --csrf_token abc --random_port\n6 5 node hook.ts', 6)).toEqual({ pid: 5, csrf: 'abc' })
  })

  test('under the CLI is agy itself, which runs the server inside it, with the token pace started it with', () => {
    // agy takes its token from ANTIGRAVITY_CSRF_TOKEN; its arguments name none
    const cli = ' 700 1 -zsh\n 800 700 /Users/u/.local/bin/agy\n 810 800 node /work/pace/adapters/antigravity/hook.ts PreInvocation'
    expect(serverOf(cli, 810, 'tok-1')).toEqual({ pid: 800, csrf: 'tok-1' })
    expect(serverOf(cli, 810)).toBeNull()
  })

  test('is none when no language server runs the hook', () => {
    expect(serverOf(ps, 900)).toBeNull()
    expect(serverOf('', 1201)).toBeNull()
  })

  test('listens on the ports lsof names', () => {
    expect(portsOf('p950\nf12\nn127.0.0.1:53110\nf13\nn*:53111\nf14\nn[::1]:53112\n')).toEqual([53110, 53111, 53112])
    expect(portsOf('')).toEqual([])
  })
})

describe('the account a GetUserStatus answer is for', () => {
  test('is the email it names; none when it names none', () => {
    expect(emailOf({ userStatus: { email: 'a@b.co' } })).toBe('a@b.co')
    expect(emailOf({ userStatus: {} })).toBeNull()
    expect(emailOf(null)).toBeNull()
  })
})
