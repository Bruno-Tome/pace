// What pace's views slice things by, and how each is named: one place for the fleet and activity alike. Pure.

import { accountLabel, type Accounts } from './account.ts'
import { PROVIDER_NAME, type PaceHost, type PaceProvider } from './host.ts'

/** What a view slices by */
export type Dim = 'provider' | 'account' | 'harness' | 'repo' | 'model'
export const DIMS: readonly Dim[] = ['provider', 'account', 'harness', 'repo', 'model']
export const DIM_NAME: Record<Dim, string> = { provider: 'Provider', account: 'Account', harness: 'Harness', repo: 'Repo', model: 'Model' }

/** Each harness by the name it goes by */
export const HOST_NAME: Record<PaceHost, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', antigravity: 'Antigravity', hermes: 'Hermes' }

/** A folder's repo: its last part */
export const repoOf = (cwd: string) => cwd.replace(/\/+$/, '').split('/').pop() || cwd

/**
 * A worktree's repo: the one its git common folder (`git rev-parse --git-common-dir`) belongs to, the folder holding
 * `.git`, or a bare repo's own name; null for none
 */
export function repoOfGitDir(commonDir: string): string | null {
  const dir = commonDir.trim().replace(/\/+$/, '')
  if (!dir) return null
  return dir.endsWith('/.git') ? repoOf(dir.slice(0, -5)) : repoOf(dir).replace(/\.git$/, '')
}

/** A model by its short name: no `claude-` before it, no date after it */
export const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

/** A value of a dimension as the user knows it; an account by its number on its provider, as the fleet shows it */
export function labelOf(dim: Dim, value: string, o: { provider?: string; accounts?: Accounts } = {}): string {
  if (!value) return 'none'
  if (dim === 'provider') return PROVIDER_NAME[value as PaceProvider] ?? value
  if (dim === 'harness') return HOST_NAME[value as PaceHost] ?? value
  if (dim === 'model') return shortModel(value)
  if (dim === 'account') return accountLabel(PROVIDER_NAME[o.provider as PaceProvider] ?? 'Account', o.accounts ?? {}, o.provider ?? '', value)
  return value
}
