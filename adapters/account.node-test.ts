// The account a Node adapter's session spends: pace's key made once, the email hashed, the account numbered. Run by
// Node: `node --test adapters/account.node-test.ts`.

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../testing/node.ts'
import { accountFor, ACCOUNTS_FILE, KEY_FILE } from './account.ts'

describe('the account a session spends', () => {
  test('is the email hashed under a key pace makes once, private to the user', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-account-'))
    const id = accountFor(home, 'codex', 'Bruno@Example.com')!
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(statSync(join(home, KEY_FILE)).mode & 0o777).toBe(0o600)
    expect(accountFor(home, 'claude', 'bruno@example.com')).toBe(id)
    expect(readFileSync(join(home, KEY_FILE), 'utf8')).not.toContain('bruno')
  })

  test('is numbered per provider as first seen, and none without an email', () => {
    const home = mkdtempSync(join(tmpdir(), 'pace-account-'))
    const a = accountFor(home, 'codex', 'a@x.co')!
    const b = accountFor(home, 'codex', 'b@x.co')!
    accountFor(home, 'codex', 'a@x.co')
    expect(JSON.parse(readFileSync(join(home, ACCOUNTS_FILE), 'utf8'))).toEqual({ codex: [a, b] })
    expect(accountFor(home, 'codex', null)).toBeUndefined()
    expect(readFileSync(join(home, ACCOUNTS_FILE), 'utf8')).not.toContain('@')
  })
})
