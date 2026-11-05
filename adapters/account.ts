// The account a Node adapter's session spends (.agents/decisions/0017-quota-is-provider-and-account.md): the email its
// harness signed in with, hashed under pace's key (core/account.ts). The key is made once, 32 random bytes in
// ~/.local/state/pace/key, readable by the user alone; the accounts are numbered as first seen, in
// ~/.local/state/pace/accounts.json, which holds ids only. No email is written anywhere.

import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { accountId, numbered, type Accounts } from '../core/account.ts'

export const KEY_FILE = '.local/state/pace/key'
export const ACCOUNTS_FILE = '.local/state/pace/accounts.json'

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  // A temp file of this process's own: two writing at once never rename each other's away
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

/** pace's key, made on first use */
function keyIn(home: string): string {
  const path = join(home, KEY_FILE)
  const stored = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  if (/^[0-9a-f]{64}$/.test(stored)) return stored
  // Made by one process alone: an exclusive create, so two sessions starting at once never hash with two keys
  mkdirSync(dirname(path), { recursive: true })
  try {
    const fd = openSync(path, 'wx', 0o600)
    writeSync(fd, randomBytes(32).toString('hex'))
    closeSync(fd)
  } catch {}
  for (let tries = 0; tries < 50; tries++) {
    const made = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(made)) return made
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  throw new Error('pace: the key file is not a key')
}

/** The accounts pace has seen; what parses of them */
export function accountsIn(home: string): Accounts {
  try {
    const v = JSON.parse(readFileSync(join(home, ACCOUNTS_FILE), 'utf8')) as unknown
    if (typeof v !== 'object' || v == null || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).map(([k, ids]) => [k, Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []]))
  } catch {
    return {}
  }
}

/** The account `email` is on `provider`, numbered when new; none without an email */
export function accountFor(home: string, provider: string, email: string | null | undefined): string | undefined {
  if (!email || !email.includes('@')) return undefined
  return numberedId(home, provider, email)
}

/**
 * The account a harness names by an identity of its own, not an email (Hermes's pooled `codex:<account>:<user>`),
 * hashed the same way, so it never shows; numbered when new
 */
export function accountForIdentity(home: string, provider: string, identity: string | null | undefined): string | undefined {
  return identity ? numberedId(home, provider, identity) : undefined
}

function numberedId(home: string, provider: string, name: string): string {
  const id = accountId(name, keyIn(home))
  const before = accountsIn(home)
  const after = numbered(before, provider, id)
  if (after !== before) write(join(home, ACCOUNTS_FILE), JSON.stringify(after))
  return id
}
