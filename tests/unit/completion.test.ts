import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/composables/useFileStore', () => ({
  useFileStore: () => ({ states: {} })
}))
vi.mock('../../src/renderer/src/lib/remoteContext', () => ({
  getContainers: vi.fn(async () => []),
  getUnits: vi.fn(async () => [])
}))

import {
  buildCompgenCommand,
  extractWordAt,
  longestCommonPrefix,
  parseCandidates,
  tokensBefore
} from '../../src/renderer/src/lib/completion'
import { hasSpec, specCandidates } from '../../src/renderer/src/lib/specCompletion'

describe('completion text primitives', () => {
  it.each([
    ['', 0, { word: '', start: 0, isFirstWord: true }],
    ['git ch', 6, { word: 'ch', start: 4, isFirstWord: false }],
    ['git checkout', 3, { word: 'git', start: 0, isFirstWord: true }],
    ['  cat app', 9, { word: 'app', start: 6, isFirstWord: false }]
  ])('extracts the word at the caret from %j', (text, caret, expected) => {
    expect(extractWordAt(text, caret)).toEqual(expected)
  })

  it('builds a command-name query without a cwd prefix', () => {
    expect(buildCompgenCommand('ec', true, '/home/test')).toBe(
      "compgen -c -- 'ec' | sort -u | head -n 100"
    )
  })

  it('shell-quotes file words and cwd in a file query', () => {
    expect(buildCompgenCommand("a'b", false, "/home/Test User's")).toContain(
      "cd '/home/Test User'\\''s' 2>/dev/null;"
    )
    expect(buildCompgenCommand("a'b", false, "/home/Test User's")).toContain(
      "compgen -d -- 'a'\\''b'"
    )
  })

  it('deduplicates directory/file echoes, sorts candidates and removes blank lines', () => {
    expect(parseCandidates('www\napp.log\r\nwww/\n\nconfig.yaml\n')).toEqual([
      'app.log',
      'config.yaml',
      'www/'
    ])
  })

  it('extracts completed tokens before the current word', () => {
    expect(tokensBefore('kubectl -n prod logs ap', 21)).toEqual([
      'kubectl',
      '-n',
      'prod',
      'logs'
    ])
  })

  it.each([
    [[], ''],
    [['config.yaml'], 'config.yaml'],
    [['config.yaml', 'config.local.yaml'], 'config.'],
    [['alpha', 'beta'], '']
  ])('finds the longest common prefix of %j', (items, expected) => {
    expect(longestCommonPrefix(items)).toBe(expected)
  })
})

describe('withfig-derived completion specs', () => {
  it('provides described git subcommands for a partial token', () => {
    const candidates = specCandidates(['git'], 'ch')

    expect(candidates.map((item) => item.label)).toContain('checkout')
    expect(candidates.find((item) => item.label === 'checkout')?.description).toBeTruthy()
  })

  it('fills a unique git flag candidate', () => {
    expect(specCandidates(['git', 'commit'], '--am')).toEqual([
      expect.objectContaining({ label: '--amend' })
    ])
  })

  it('reports whether a command has an extracted spec', () => {
    expect(hasSpec('git')).toBe(true)
    expect(hasSpec('definitely-not-a-command')).toBe(false)
  })
})
