# Open-sourcing pace

Goal: a public GitHub repo for pace, a terminal-first take on
[weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken)'s idea with its own code, installable with
`/plugin install`, that someone else can read and extend.

Every step keeps `claude plugin test .`, `claude plugin validate .` and `tsc -p .` green.

## 1. Repository and licensing

- [x] Git repository at `~/personal-projects/pace`, developed through `CLAUDE_CODE_PLUGIN_DIRS` / `--plugin-dir`.
- [x] `LICENSE` (MIT). No weektoken code is kept, so no second licence.
- [x] `.gitignore`: `.claude-plugin/types/`, `node_modules/`, `.DS_Store`.
- [x] `.claude-plugin/marketplace.json`.
- [x] `author`, `keywords`, `homepage` and `repository` in `plugin.json`.
- [x] Secrets scan before the first push, by hand (the plugin-authoring scan can't run on this machine): every
      tracked and untracked file and the full history, for keys, tokens, private keys, home paths and emails.
      None found. The credential is only ever a handle from `$.session.authorize()`. Commits carry the author's
      personal email, which goes public with the history.
- [x] Public repo at [Bruno-Tome/pace](https://github.com/Bruno-Tome/pace), the owner in both READMEs' install line.

## 2. Positioning

- [x] README in English and Chinese: weektoken as the inspiration, pace as its own terminal-first port with
      upgrades.
- [x] The vendored model replaced by pace's own (`hooks/quota.ts`); `pace.ts`, `i18n.ts` and `LICENSE.weektoken`
      removed.
- [x] `CHANGELOG.md`, its first entry listing what differs from weektoken.

## 3. Code polish

1. [x] `tsc -p .` clean with stock TypeScript (`allowImportingTsExtensions`, `noEmit`).
2. [x] Own quota model, Pace-prefixed contract types, readable data shapes.
3. [ ] Type the hooks module: replace `$: any` with the engine's types. Splitting `register.tsx` further is
       limited by two engine rules: a `$.state` atom must be read in the file that defines it, and `$` is
       followed across files only into `function` declarations. Pure logic already lives in its own modules
       (`model`, `view`, `quota`, `rate`, `spend`, `cache`, `alerts`, `auto`).
4. [ ] One compact layout: the status-line row and `lineText` drawn from `bandLines`.
5. [ ] File paths in one constants block, shared with `bin/viewer.ts`.
6. [x] Test the viewer: its key handling is `keyAction` in `view.ts`.
7. [x] Drop `rateVerdict`; its tests use `rateSince`.
8. [x] A malformed stored reading is dropped, not thrown over.

## 4. Docs

- [ ] Screenshots or an asciinema clip: the band, the window in two columns, a focused chart, auto mode's pane.
- [ ] Platform table: the band and pane work anywhere Claude Code runs; the window is macOS-only.

## 5. Release

- [ ] 1.0.0 once 1–4 are done; tag `v1.0.0`.
- [ ] CI running `claude plugin validate .` and `claude plugin test .` (check the CLI runs headless in Actions;
      otherwise `tsc` in CI and the rest before tagging).
