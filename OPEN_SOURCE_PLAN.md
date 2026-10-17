# Open-sourcing pacebar

Goal: a public GitHub repo that's clearly a terminal-based port of
[weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken) plus small upgrades and QoL changes,
installable with `/plugin install`, with code someone else can read and extend.

Every step keeps `claude plugin test .` and `claude plugin validate .` green.

## 1. Repository and licensing

- [ ] `git init` the mod folder. Develop from a clone through `--plugin-dir` instead of editing `~/.claude/mods`
      in place.
- [ ] `LICENSE`: MIT, your copyright. Keep `LICENSE.weektoken` and say in the README which files it covers.
- [ ] `.gitignore`: `.claude-plugin/types/` (the engine writes it on load) and `node_modules/`.
- [ ] `.claude-plugin/marketplace.json` so `/plugin install pacebar --marketplace <owner>/pacebar` works.
- [ ] Add `author`, `homepage` and `repository` to `plugin.json`.
- [ ] Run a secrets scan over the tree before the first push (the plugin-authoring `scan_secrets` tool).

## 2. Attribution and positioning

- [x] README: what weektoken is, a link to it, credit to mj0111, and that this repo is the terminal-based port
      with upgrades.
- [ ] Keep the "Vendored from weektoken" header on each vendored file. Rename `pace.ts` to `weektoken.ts` so the
      boundary between their code and pacebar's shows in the file list.
- [ ] `CHANGELOG.md` from 0.1.0. Its first entry lists what changed against weektoken: terminal surfaces, burst vs
      too fast, cache timer and dollars, warm mode, shared spend and pacing, the `/pace` window.
- [ ] Optional: open an issue or discussion on weektoken's repo to let the author know about the port.

## 3. Code polish

In order. Each item is its own commit with tests green.

1. **Make `tsc -p .` clean with any TypeScript.** Add `allowImportingTsExtensions` and `noEmit` to the mod's
   `tsconfig.json`. A stock tsc currently fails every `./x.ts` import with TS5097.
2. **Trim the vendored model.** Delete the parts of `pace.ts` pacebar never imports. Fix its ~50 strict-mode
   errors. Decide on i18n: either drop the Chinese strings and `i18n.ts`, or keep both languages and detect the
   language for real, as weektoken does (register.tsx forces `en` today). Recommendation: keep them. It costs
   little and stays true to the original.
3. **Type the hooks module.** Replace `$: any` and `e: any` in `register.tsx` with the engine's types. Split it,
   since it's ~500 lines doing four jobs:
   - `store.ts`: shared samples, prompts, spend and prices, merged with the store
   - `sources.ts`: rate limits, `~/.claude.json`, the usage endpoint
   - `window.ts`: state feed, keys file, launcher
   - `register.tsx`: hooks and drawing only
4. **One compact layout** (from the roadmap): the status-line row and `lineText` drawn from `bandLines`, so all
   four surfaces share one layout.
5. **Paths in one place.** The four `~/.claude/pacebar-*` files go into one constants block. Document them in the
   README.
6. **Test the viewer.** Move its key handling (focus toggle, keys file) into a pure function in `view.ts` and
   test it. `bin/viewer.ts` keeps only the I/O.
7. **Naming and comments pass.** One vocabulary across the code: quota, window, reading (now "sample"/"obs"),
   spend, rate. Remove leftovers like `rateVerdict`, a 5-hour-only wrapper the model no longer uses.
8. **Bounds.** Caps on store sizes: samples 8000, prompts 4000, spend 8 days folded hourly. Make sure a corrupt
   store value can't throw in `load`.

## 4. Docs

- [ ] Screenshots or an asciinema clip of the band, the window in two columns and a focused chart.
- [ ] A "How pacing works" section: the pace model (weektoken's), burst vs too fast, %/$ from shared spend, and
      its limits (usage outside Claude Code, whole-point readings).
- [ ] Platform support table: the band and pane work anywhere Claude Code runs; the window is macOS-only until
      the "Other terminals" roadmap item lands.

## 5. Release

- [ ] Version 1.0.0 once 1–4 are done. Tag `v1.0.0`.
- [ ] CI: a GitHub Action that runs `claude plugin validate .` and `claude plugin test .`. First check that the
      CLI installs and runs headless in Actions; if it doesn't, fall back to `tsc` plus validate run locally
      before tagging.
- [ ] Optional: also publish to your organization's plugin library.

## Open decisions

- The repo name: `pacebar`, or something that says "weektoken for the terminal".
- Whether to keep the bilingual copy (see 3.2).
