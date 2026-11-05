import { describe, expect, test } from 'claude-code/testing'

import { bandArgs } from './commands.ts'

describe('a view outside Herdr', () => {
  test('is bin/band.ts in a terminal window: the charts and the band of the conversation\'s feed, or the fleet', () => {
    expect(bandArgs('pane', '/h/feed.json')).toEqual(['--pane', '/h/feed.json'])
    expect(bandArgs('band', '/h/feed.json')).toEqual(['/h/feed.json'])
    expect(bandArgs('fleet', '/h/feed.json')).toEqual(['--fleet'])
  })
})
