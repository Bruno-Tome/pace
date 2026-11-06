import { describe, expect, test } from 'claude-code/testing'

import { DIMS, labelOf, repoOf, repoOfGitDir, shortModel } from '../core/dims.ts'

describe('what activity and the fleet slice by', () => {
  test('provider, account, harness, repo and model', () => {
    expect(DIMS).toEqual(['provider', 'account', 'harness', 'repo', 'model'])
  })

  test('a repo is its folder\'s name', () => {
    expect(repoOf('/Users/me/work/pace/')).toBe('pace')
    expect(repoOf('/')).toBe('/')
  })

  test('a worktree\'s repo is the one its git common folder belongs to', () => {
    expect(repoOfGitDir('/Users/me/work/maestro/.git')).toBe('maestro')
    expect(repoOfGitDir('/Users/me/work/maestro/.git/')).toBe('maestro')
    // A bare repo is its own folder
    expect(repoOfGitDir('/srv/git/pace.git')).toBe('pace')
    expect(repoOfGitDir('')).toBe(null)
  })

  test('a model by its short name: no vendor prefix, no date', () => {
    expect(shortModel('claude-opus-4-6-20260101')).toBe('opus-4-6')
    expect(shortModel('gpt-5.5')).toBe('gpt-5.5')
  })

  test('each value labelled as the user knows it', () => {
    expect(labelOf('provider', 'codex')).toBe('Codex')
    expect(labelOf('harness', 'claude')).toBe('Claude Code')
    expect(labelOf('model', 'claude-haiku-4-5')).toBe('haiku-4-5')
    expect(labelOf('repo', 'pace')).toBe('pace')
    // An account by its number on the provider, as the fleet shows it
    expect(labelOf('account', '1233abcd5678ef90', { provider: 'codex', accounts: { codex: ['ffff000011112222', '1233abcd5678ef90'] } })).toBe('Codex account 2 · 1233ab…')
    expect(labelOf('provider', '')).toBe('none')
  })
})
