// Antigravity's readings, asked of its language server on loopback: the one that runs this process (a hook's
// ancestor; under the CLI, `agy` itself, its token from ANTIGRAVITY_CSRF_TOKEN), or the `agy` whose pid pace started
// (bin/pace-acp.ts). Used by the hook and the ACP proxy; nothing leaves the machine
// (.agents/decisions/0020-antigravity-cli.md).

import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import type { PaceSample } from '../../types'
import { CSRF_HEADER, emailOf, GET_USER_STATUS, portsOf, sampleOf, serverOf } from './status.ts'

/** How long one question to the language server may take: the agent waits for the hook */
const ASK_TIMEOUT_MS = 1500

/** A command's output; '' when it fails or is not there */
function run(cmd: string, args: readonly string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** GetUserStatus's answer from the language server on `port` of loopback; null when it does not give one */
function ask(port: number, secure: boolean, csrf: string): Promise<unknown> {
  const body = '{}'
  const options = {
    host: '127.0.0.1', port, path: GET_USER_STATUS, method: 'POST', timeout: ASK_TIMEOUT_MS,
    headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', [CSRF_HEADER]: csrf },
    // The language server's certificate is its own, on loopback
    ...(secure ? { rejectUnauthorized: false } : {}),
  }
  return new Promise(resolve => {
    const req = (secure ? httpsRequest : httpRequest)(options, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(text) : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end(body)
  })
}

/** Each model's reading now, and whose account it is, from the language server that runs this hook; null when there is none to ask */
export async function readingNow(known: readonly PaceSample[], now: number, at?: { pid: number; csrf: string }): Promise<{ sample: PaceSample; email: string | null } | null> {
  const server = at ?? serverOf(run('ps', ['-A', '-o', 'pid=,ppid=,command=']), process.pid, process.env.ANTIGRAVITY_CSRF_TOKEN || undefined)
  if (!server) return null
  for (const port of portsOf(run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(server.pid), '-Fn']))) {
    for (const secure of [false, true]) {
      const told = await ask(port, secure, server.csrf)
      const sample = sampleOf(told, now, known)
      if (sample) return { sample, email: emailOf(told) }
    }
  }
  return null
}

