// Builds pace for Herdr. Herdr's mods are plain JS that import only from their own folder, so this strips the
// types (node:module's stripTypeScriptTypes) from each module and every relative module it imports, into one
// folder, with imports pointed at the built .js files.
//
//   node scripts/herdr.ts check     builds the mod, and the core suite as a check-only mod, each into a scratch
//                                   folder, and runs `herdr-app check` on both: the core's tests pass inside
//                                   Herdr's own runtime. Then the load check: the mod started on feeds the size
//                                   real use makes, each step of each view checked on its own, so a step that
//                                   runs past Herdr's time budget fails here rather than draw nothing in the app
//   node scripts/herdr.ts install   builds the mod into ~/.config/herdr-app/mods/pace/ (HERDR_APP_HOME first) and
//                                   checks it there; files of an earlier build are written over, never deleted

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import type { HerdrView } from '../adapters/herdr/open.ts'
import { loadFeeds } from '../testing/load.ts'

const root = join(import.meta.dirname, '..')

/** Where the runner for claude-code/testing sits in a built folder */
const RUNNER = 'testing/herdr.js'

/** A relative import's specifier, `from './x.ts'` or `import './x.ts'`, ending in .ts */
const RELATIVE_TS = /(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g

/** A module as plain JS for a mod: types stripped, imports pointed inside the mod's folder */
export function jsOf(source: string, file: string): string {
  const runner = posix.relative(posix.dirname(file), RUNNER)
  return stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(RELATIVE_TS, (_, lead: string, quote: string, path: string) => `${lead}${quote}${path}.js${quote}`)
    .replace(/(['"])claude-code\/testing\1/g, `'${runner.startsWith('.') ? runner : `./${runner}`}'`)
}

/** The repo's .ts files these reach, themselves included: each entry and every relative .ts it imports */
function reach(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(join(root, file), 'utf8')
    for (const [, , , path] of source.matchAll(RELATIVE_TS)) visit(posix.join(posix.dirname(file), `${path}.ts`))
  }
  entries.forEach(visit)
  return [...seen].sort()
}

/** Writes each .ts file as .js at the same path under `out`, then the files given as they are */
function build(out: string, files: readonly string[], extra: Readonly<Record<string, string>>): void {
  for (const file of files) {
    const js = file.replace(/\.tsx?$/, '.js')
    mkdirSync(dirname(join(out, js)), { recursive: true })
    writeFileSync(join(out, js), jsOf(readFileSync(join(root, file), 'utf8'), js))
  }
  for (const [path, text] of Object.entries(extra)) writeFileSync(join(out, path), text)
}

/** The mod's own files: adapters/herdr/ and the core it reaches, its main.js the adapter's */
function buildMod(out: string): void {
  build(out, reach(['adapters/herdr/main.ts']), {
    'main.js': "// pace in Herdr. Built by scripts/herdr.ts from the pace repo; edits here are overwritten.\nexport { default } from './adapters/herdr/main.js'\n",
    'mod.json': `${JSON.stringify({ place: 'right', size: 420, title: 'Pace' }, null, 2)}\n`,
  })
}

/** Where Herdr keeps its mods, HERDR_APP_HOME first */
const modsFolder = () => join(process.env.HERDR_APP_HOME ?? join(homedir(), '.config', 'herdr-app'), 'mods')

/** The core suite's test files: the ones that need nothing but the core, on every host */
function suiteFiles(): string[] {
  const tests = readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.test.ts')).map((name) => `tests/${name}`)
  return [...tests, ...['adapters/codex', 'adapters/herdr'].flatMap(testsIn)]
}

function testsIn(dir: string): string[] {
  if (!existsSync(join(root, dir))) return []
  return readdirSync(join(root, dir)).filter((name) => name.endsWith('.test.ts')).map((name) => `${dir}/${name}`)
}

/** The check-only mod's main.js: loads every test, runs them, and fails the check with each failure */
function suiteMain(tests: readonly string[]): string {
  const imports = tests.map((file) => `import './${file.replace(/\.ts$/, '.js')}'`).join('\n')
  return `// pace's core suite, run inside Herdr by \`herdr-app check\`. Built by scripts/herdr.ts; not a mod to keep.
import { View, div } from 'gpui-kit'
import { run } from './${RUNNER}'
${imports}

const result = run()

export default class PaceSuite extends View {
  render() {
    if (result.total === 0) throw new Error('pace suite: no tests ran')
    if (result.failures.length > 0) {
      const each = result.failures.map((f) => \`✖ \${f.name}\\n\${f.message}\`).join('\\n\\n')
      throw new Error(\`pace suite: \${result.failures.length} of \${result.total} failed\\n\\n\${each}\`)
    }
    return div().child(\`pace suite: \${result.total} passed\`)
  }
}
`
}

/** Runs `herdr-app check` on a folder; throws with its output when the check fails */
function check(folder: string, what: string): void {
  try {
    execFileSync('herdr-app', ['check', folder], { stdio: 'pipe', encoding: 'utf8' })
    process.stdout.write(`✔ ${what}: herdr-app check passed\n`)
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
    process.stderr.write(`✖ ${what}: herdr-app check failed\n${stdout}${stderr}`)
    process.exitCode = 1
  }
}

function checkSuite(): void {
  const out = mkdtempSync(join(tmpdir(), 'pace-herdr-suite-'))
  try {
    const tests = suiteFiles()
    build(out, reach([...tests, 'testing/herdr.ts']), { 'main.js': suiteMain(tests), 'mod.json': '{ "place": "none" }\n' })
    check(out, `core suite (${tests.length} files)`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

function checkMod(): void {
  const out = mkdtempSync(join(tmpdir(), 'pace-herdr-mod-'))
  try {
    buildMod(out)
    check(out, 'mod')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

/** The load check's cases: a view and one of its steps (see `steps` in adapters/herdr/main.ts) */
const LOAD: readonly { what: string; view: HerdrView; step: number }[] = [
  { what: 'panel: the fleet', view: { view: 'panel' }, step: 0 },
  { what: 'Claude\'s charts', view: { view: 'pane', provider: 'claude' }, step: 0 },
  { what: 'Codex\'s charts', view: { view: 'pane', provider: 'codex' }, step: 0 },
  { what: 'a band', view: { view: 'band', terminal: 't1' }, step: 0 },
]

function checkLoad(): void {
  const out = mkdtempSync(join(tmpdir(), 'pace-herdr-load-'))
  try {
    buildMod(out)
    const feeds = loadFeeds(Date.now())
    for (const { what, view, step } of LOAD) {
      const seed = { view, cols: 80, rows: 60, feeds, step }
      writeFileSync(join(out, 'adapters/herdr/seed.js'), `export const SEED = ${JSON.stringify(seed)}\n`)
      check(out, `load: ${what}`)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

function install(): void {
  const out = join(modsFolder(), 'pace')
  mkdirSync(out, { recursive: true })
  buildMod(out)
  check(out, `mod installed in ${out}`)
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === 'check') {
    checkMod()
    checkSuite()
    checkLoad()
  } else if (command === 'install') {
    install()
  } else {
    process.stderr.write('usage: node scripts/herdr.ts check | install\n')
    process.exitCode = 2
  }
}
