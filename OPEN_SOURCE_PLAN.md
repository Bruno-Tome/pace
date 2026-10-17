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
- [x] `author` and `keywords` in `plugin.json`. Add `homepage` and `repository` once the GitHub repo exists.
- [ ] Secrets scan before the first push. The plugin-authoring scan can't run on this machine (organization
      policy), so either run it where it can, or review the staged files by hand before pushing.
- [ ] Choose the GitHub owner, create the repo (public), push, and replace `<owner>` in both READMEs.

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
6. [ ] Test the viewer: move its key handling into a pure function in `view.ts`.
7. [ ] Drop `rateVerdict`, a 5-hour-only wrapper the model no longer uses (its tests move to `rateSince`).
8. [ ] Make sure a corrupt store value can't throw in `load`.

## 4. Docs

- [ ] Screenshots or an asciinema clip: the band, the window in two columns, a focused chart, auto mode's pane.
- [ ] Platform table: the band and pane work anywhere Claude Code runs; the window is macOS-only.

## 5. Release

- [ ] 1.0.0 once 1–4 are done; tag `v1.0.0`.
- [ ] CI running `claude plugin validate .` and `claude plugin test .` (check the CLI runs headless in Actions;
      otherwise `tsc` in CI and the rest before tagging).
