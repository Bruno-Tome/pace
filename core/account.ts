// Whose account a session spends (.agents/decisions/0017-quota-is-provider-and-account.md): the email the harness
// signed in with, hashed with one key pace keeps on this machine, so the same email gives the same id in every
// harness and the id cannot be traced back to it. The hash is written here, in plain TypeScript, because the core
// imports no runtime's crypto. Pure.

import type { PaceFeed, PaceProvider } from './host.ts'

/** A string's UTF-8 bytes, by hand: Herdr's runtime has no TextEncoder */
export function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 of `msg` (FIPS 180-4) */
function sha256(msg: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const padded = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64)
  padded.set(msg)
  padded[msg.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(msg.length / 0x20000000))
  view.setUint32(padded.length - 4, (msg.length * 8) >>> 0)
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    const out = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + out[i]!) >>> 0
  }
  const digest = new Uint8Array(32)
  const dv = new DataView(digest.buffer)
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, h[i]!)
  return digest
}

/** HMAC-SHA-256 (RFC 2104) */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = new Uint8Array(64)
  k.set(key.length > 64 ? sha256(key) : key)
  const inner = new Uint8Array(64 + msg.length)
  const outer = new Uint8Array(96)
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i]! ^ 0x36
    outer[i] = k[i]! ^ 0x5c
  }
  inner.set(msg, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

const hexOf = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const bytesOf = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map(x => parseInt(x, 16)))

/** An account's id: the sign-in's email, trimmed and lower-cased, hashed under pace's key (hex); 16 hex digits */
export function accountId(email: string, keyHex: string): string {
  return hexOf(hmacSha256(bytesOf(keyHex), utf8(email.trim().toLowerCase()))).slice(0, 16)
}

/** The accounts pace has seen, by provider, in the order it first saw each */
export type Accounts = Partial<Record<string, string[]>>

/** The accounts with `id` added to its provider's, when it is new */
export function numbered(reg: Accounts, provider: string, id: string): Accounts {
  const ids = reg[provider] ?? []
  return ids.includes(id) ? reg : { ...reg, [provider]: [...ids, id] }
}

/** How an account is listed: `Codex account 2 · 1233ab…`; the provider alone when the account is not known */
export function accountLabel(name: string, reg: Accounts, provider: string, id: string | undefined): string {
  if (!id) return name
  const n = (reg[provider] ?? []).indexOf(id) + 1
  return `${name} account ${n || '?'} · ${id.slice(0, 6)}…`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** A base64url text's bytes, as a string; null when it is not base64url */
function fromBase64url(s: string): string | null {
  let bits = 0
  let acc = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')) {
    const v = B64.indexOf(ch)
    if (v < 0) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  // UTF-8 by hand: Herdr's runtime has no TextDecoder
  try {
    return decodeURIComponent(out.map(b => `%${b.toString(16).padStart(2, '0')}`).join(''))
  } catch {
    return null
  }
}

/** The `email` claim of a sign-in token (a JWT); null when it carries none */
export function emailOfJwt(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(fromBase64url(payload) ?? '') as unknown
    const email = typeof claims === 'object' && claims != null ? (claims as Record<string, unknown>).email : undefined
    return typeof email === 'string' && email.includes('@') ? email : null
  } catch {
    return null
  }
}

/** The one account `provider`'s live feeds name, for a host that cannot tell; none when they name none or more than one */
export function soleAccount(feeds: readonly PaceFeed[], provider: PaceProvider): string | undefined {
  const ids = new Set(feeds.filter(f => f.provider === provider && f.account).map(f => f.account!))
  return ids.size === 1 ? [...ids][0] : undefined
}

/**
 * The feeds a session learns its quota's history from. One that knows its account takes them all, and the quota picks
 * its own (core/meter.ts). One that does not, while its provider has two accounts or more here, takes only the feeds
 * that name none: any other could be another account's, and its readings would be the wrong quota's
 */
export function learnsFrom(feeds: readonly PaceFeed[], provider: PaceProvider, account: string | undefined): PaceFeed[] {
  if (account) return [...feeds]
  const ids = new Set(feeds.filter(f => f.provider === provider && f.account).map(f => f.account))
  return ids.size > 1 ? feeds.filter(f => f.provider !== provider || !f.account) : [...feeds]
}
