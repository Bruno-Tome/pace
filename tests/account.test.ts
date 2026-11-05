import { describe, expect, test } from 'claude-code/testing'

import type { PaceFeed } from '../core/host.ts'
import { accountId, accountLabel, emailOfJwt, hmacSha256, learnsFrom, numbered, soleAccount, utf8 } from '../core/account.ts'

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

describe('the keyed hash', () => {
  test('is HMAC-SHA-256 (RFC 4231\'s test cases)', () => {
    expect(hex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    const key = new Uint8Array(131).fill(0xaa)
    expect(hex(hmacSha256(key, utf8('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
  })
})

describe('an account', () => {
  test('hashes the email\'s UTF-8 bytes, whatever the script', () => {
    expect([...utf8('é€😀')]).toEqual([0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80])
  })

  test('is the same id for the same email in every harness: trimmed, any case', () => {
    const id = accountId('Bruno@Example.com ', KEY)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(accountId('bruno@example.com', KEY)).toBe(id)
    expect(accountId('other@example.com', KEY)).not.toBe(id)
  })

  test('is another id under another key: without the key it cannot be traced to the email', () => {
    expect(accountId('bruno@example.com', KEY.replace(/^00/, '01'))).not.toBe(accountId('bruno@example.com', KEY))
  })

  test('is numbered per provider in the order pace first saw it', () => {
    let reg = numbered({}, 'codex', 'aaaa')
    reg = numbered(reg, 'codex', 'bbbb')
    reg = numbered(reg, 'codex', 'aaaa')
    reg = numbered(reg, 'claude', 'bbbb')
    expect(reg).toEqual({ codex: ['aaaa', 'bbbb'], claude: ['bbbb'] })
  })

  test('is listed by its number and the start of its id', () => {
    expect(accountLabel('Codex', { codex: ['aaaa', '1233abcd5678ef90'] }, 'codex', '1233abcd5678ef90')).toBe('Codex account 2 · 1233ab…')
    expect(accountLabel('Codex', {}, 'codex', undefined)).toBe('Codex')
  })
})

describe('where an account comes from', () => {
  test('a sign-in token\'s email claim', () => {
    // {"email":"a@b.co"} as a JWT's payload, base64url
    expect(emailOfJwt('x.eyJlbWFpbCI6ImFAYi5jbyJ9.y')).toBe('a@b.co')
    expect(emailOfJwt('x.eyJzdWIiOiIxIn0.y')).toBeNull()
    expect(emailOfJwt('junk')).toBeNull()
  })

  test('a host that cannot tell joins the one account the provider has on this machine, and none when there are more', () => {
    const f = (account?: string): PaceFeed => ({ version: 1, host: 'codex', provider: 'codex', ...(account ? { account } : {}), session: 's', cwd: '/', at: 0, snapshot: { samples: [], prompts: [], cache: null } })
    expect(soleAccount([f('a1'), f('a1'), f()], 'codex')).toBe('a1')
    expect(soleAccount([f('a1'), f('a2')], 'codex')).toBeUndefined()
    expect(soleAccount([f('a1')], 'claude')).toBeUndefined()
  })
})

describe('the feeds a session with no account of its own learns from', () => {
  const f = (account?: string): PaceFeed => ({ version: 1, host: 'codex', provider: 'codex', ...(account ? { account } : {}), session: account ?? 'none', cwd: '/', at: 0, snapshot: { samples: [], prompts: [], cache: null } })

  test('are every feed on the provider while it has one account here, or none', () => {
    expect(learnsFrom([f('a1'), f()], 'codex', undefined).map(x => x.session)).toEqual(['a1', 'none'])
  })

  test('are only the feeds that name no account once it has two: either could be another account\'s', () => {
    expect(learnsFrom([f('a1'), f('a2'), f()], 'codex', undefined).map(x => x.session)).toEqual(['none'])
  })

  test('are all of them for a session that knows its account: the quota picks its own', () => {
    expect(learnsFrom([f('a1'), f('a2')], 'codex', 'a1').length).toBe(2)
  })
})
