// The Antigravity hook end to end: a hook's payload in, the conversation's feed and /pace's answer out, in a scratch
// home. Antigravity's language server is faked by an HTTP server on loopback, and `ps`, `lsof`, `open`, `osascript`
// and `herdr-app` by scripts on the PATH that log their arguments. Run by Node:
// `node --test adapters/antigravity/hook.node-test.ts`.

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '../../testing/node.ts'

const HOOK = join(import.meta.dirname, 'hook.ts')
const CSRF = '0f3c-41aa'
const H = 3600_000

// Whatever runs the tests: nothing here may reach the real Herdr or tmux
delete process.env.HC_TERMINAL_ID
delete process.env.TMUX

/** The language server's GetUserStatus answer: Gemini 3.1 Pro's 5-hour window 40% used */
const answer = () => JSON.stringify({
  userStatus: { email: 'a@b.co', cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Gemini 3.1 Pro (High)', quotaInfo: { remainingFraction: 0.6, resetTime: new Date(Date.now() + 2 * H).toISOString() } },
  ] } },
})

/** A language server of the test's own: answers GetUserStatus to the right token, and counts what it was asked */
async function fakeServer(): Promise<{ server: Server; port: number; asked: string[] }> {
  const asked: string[] = []
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url} ${req.headers['x-codeium-csrf-token']}`)
    req.resume()
    req.on('end', () => {
      const ok = req.url === '/exa.language_server_pb.LanguageServerService/GetUserStatus' && req.headers['x-codeium-csrf-token'] === CSRF
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(ok ? answer() : '{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0, asked }
}

/** A scratch home with fake tools on its PATH; `server` the port of a language server running the hook */
function home(o: { server?: number; herdrFails?: boolean; cli?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pace-agy-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/calls.log"\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  // The hook's parent is the language server, started with its CSRF token
  // The CLI runs the server inside agy, with the token in ANTIGRAVITY_CSRF_TOKEN, not in its arguments
  const server = o.cli ? '/Users/u/.local/bin/agy' : `/Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token=${CSRF} --random_port`
  fake('ps', o.server ? `echo "$PPID 4242 node hook.ts"\necho "4242 1 ${server}"` : 'echo "$PPID 1 node hook.ts"')
  fake('lsof', o.server ? `printf 'p4242\\nf12\\nn127.0.0.1:${o.server}\\n'` : 'exit 1')
  fake('open', '')
  fake('osascript', '')
  fake('herdr-app', o.herdrFails ? 'exit 1' : '')
  return { dir, bin }
}

/** Runs the hook on `event` with `payload` on stdin, as Antigravity does: what it printed */
function hook(h: { dir: string; bin: string }, event: string, payload: object | string, env: Record<string, string> = {}): Promise<string> {
  const childEnv: Record<string, string | undefined> = { ...process.env, HOME: h.dir, PATH: `${h.bin}:${process.env.PATH}`, HERDR_APP_HOME: join(h.dir, 'herdr'), ...env }
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK, event], { env: childEnv, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    child.stdin!.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
}

const pre = (over: object = {}) => ({ conversationId: 'c1', workspacePaths: ['/work/pace'], modelName: 'Gemini 3.1 Pro (High)', lastUserInput: 'fix the tests', executionId: 'e1', ...over })

const feedIn = (dir: string) => JSON.parse(readFileSync(join(dir, '.local/state/pace/feeds/antigravity-c1.json'), 'utf8'))
const calls = (dir: string) => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n') : [])
const notes = (dir: string) => calls(dir).filter(c => c.startsWith('osascript'))
/** What the hook says in Antigravity itself, as the message of the turn it ends */
const said = (out: string) => JSON.parse(out).injectSteps?.[0]?.errorMessage?.userMessage as string | undefined

describe('the Antigravity hook', () => {
  test('writes the conversation\'s feed: a prompt, and the readings of the language server that runs it', async () => {
    const ls = await fakeServer()
    try {
      const h = home({ server: ls.port })
      expect(JSON.parse(await hook(h, 'PreInvocation', pre()))).toEqual({})
      const feed = feedIn(h.dir)
      expect(feed).toMatchObject({ version: 1, host: 'antigravity', provider: 'antigravity', session: 'c1', cwd: '/work/pace' })
      expect(feed.snapshot.prompts.length).toBe(1)
      expect(feed.snapshot.samples.at(-1).quotas.five_hour_gemini_3_1_pro).toMatchObject({ percent: 40, name: 'Gemini 3.1 Pro' })
      expect(ls.asked.some(a => a === `POST /exa.language_server_pb.LanguageServerService/GetUserStatus ${CSRF}`)).toBe(true)
      // The account it is signed in with, as a keyed hash of the email the server names
      expect(feed.account).toMatch(/^[0-9a-f]{16}$/)
      expect(readFileSync(join(h.dir, '.local/state/pace/feeds/antigravity-c1.json'), 'utf8')).not.toContain('a@b.co')
    } finally {
      ls.server.close()
    }
  })

  test('under the CLI asks the server inside agy, with the token agy was started with', async () => {
    const ls = await fakeServer()
    try {
      const h = home({ server: ls.port, cli: true })
      await hook(h, 'PreInvocation', pre(), { ANTIGRAVITY_CSRF_TOKEN: CSRF })
      expect(feedIn(h.dir).snapshot.samples.at(-1).quotas.five_hour_gemini_3_1_pro).toMatchObject({ percent: 40 })
    } finally {
      ls.server.close()
    }
  })

  test('asks the language server at most once a minute: hooks block the agent', async () => {
    const ls = await fakeServer()
    try {
      const h = home({ server: ls.port })
      await hook(h, 'PreInvocation', pre())
      const asked = ls.asked.length
      await hook(h, 'Stop', pre({ terminationReason: 'model_stop' }))
      expect(ls.asked.length).toBe(asked)
      expect(feedIn(h.dir).snapshot.prompts.length).toBe(1)
    } finally {
      ls.server.close()
    }
  })

  test('with no language server to ask, still writes the prompts', async () => {
    const h = home()
    expect(JSON.parse(await hook(h, 'PreInvocation', pre()))).toEqual({})
    expect(feedIn(h.dir).snapshot).toMatchObject({ samples: [], noCache: true })
    expect(feedIn(h.dir).snapshot.prompts.length).toBe(1)
  })

  test('says nothing and stops nothing on a payload it cannot read', async () => {
    const h = home()
    expect(JSON.parse(await hook(h, 'PreInvocation', 'not json'))).toEqual({})
    expect(existsSync(join(h.dir, '.local/state/pace/feeds'))).toBe(false)
  })
})

describe('/pace in Antigravity', () => {
  test('outside Herdr opens the charts in a terminal window, answers in Antigravity, and ends the run before the model', async () => {
    const h = home()
    const out = await hook(h, 'PreInvocation', pre({ lastUserInput: '/pace' }))
    expect(JSON.parse(out).terminationBehavior).toBe('terminate')
    expect(said(out)).toBe('Pace opened in a terminal window; q closes it')
    const open = calls(h.dir).find(c => c.startsWith('open '))!
    expect(open).toContain('open -a Terminal')
    const script = readFileSync(open.split(' ').at(-1)!, 'utf8')
    expect(script).toContain('bin/band.ts')
    expect(script).toContain(`'--pane' '${join(h.dir, '.local/state/pace/feeds/antigravity-c1.json')}'`)
    expect(notes(h.dir).length).toBe(0)
    expect(feedIn(h.dir).snapshot.prompts).toEqual([])
  })

  test('is carried out once a run: another model call of the same run does not open it again', async () => {
    const h = home()
    await hook(h, 'PreInvocation', pre({ lastUserInput: '/pace band' }))
    const again = JSON.parse(await hook(h, 'PreInvocation', pre({ lastUserInput: '/pace band', invocationNum: 2 })))
    expect(again).toEqual({ terminationBehavior: 'terminate' })
    expect(calls(h.dir).filter(c => c.startsWith('open ')).length).toBe(1)
  })

  test('in Herdr opens the view there first', async () => {
    const h = home()
    await hook(h, 'PreInvocation', pre({ lastUserInput: '/pace fleet' }), { HC_TERMINAL_ID: 't7' })
    expect(calls(h.dir).filter(c => c.startsWith('herdr-app do pane.split')).length).toBe(1)
    expect(calls(h.dir).some(c => c.startsWith('open '))).toBe(false)
    expect(feedIn(h.dir).terminal).toBe('t7')
  })

  test('when Herdr fails, opens the window instead and says why', async () => {
    const h = home({ herdrFails: true })
    const out = await hook(h, 'PreInvocation', pre({ lastUserInput: '/pace' }), { HC_TERMINAL_ID: 't7' })
    expect(calls(h.dir).some(c => c.startsWith('open -a Terminal'))).toBe(true)
    expect(said(out)).toContain('Could not open pace in Herdr')
  })

  test('says what Antigravity cannot do, in Antigravity', async () => {
    const h = home()
    expect(said(await hook(h, 'PreInvocation', pre({ lastUserInput: '/pace hide' })))).toBe('Antigravity has no band of its own: /pace band opens one beside it')
    expect(calls(h.dir).some(c => c.startsWith('open '))).toBe(false)
  })
})
