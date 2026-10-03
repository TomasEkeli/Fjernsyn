import { describe, expect, it } from 'vitest'

import { branchOfMerge, formatReleaseNotes } from './releaseNotes.mjs'

describe('branchOfMerge', () => {
  it('reads the branch from the subjects merges into main have', () => {
    expect(branchOfMerge('Merge feature/test-card')).toBe('feature/test-card')
    expect(branchOfMerge("Merge branch 'fix/thing'")).toBe('fix/thing')
    expect(branchOfMerge("Merge branch 'fix/thing' into main")).toBe('fix/thing')
    expect(branchOfMerge("Merge remote-tracking branch 'upstream/development' into sync/upstream-2026-10-01")).toBe('upstream/development')
  })

  it('has nothing to say about a subject that names no branch', () => {
    expect(branchOfMerge('Make the about page a test card')).toBeNull()
  })
})

describe('formatReleaseNotes', () => {
  it('lists each merged branch under its name, with its commits in order', () => {
    const notes = formatReleaseNotes({
      entries: [
        { kind: 'merge', branch: 'feature/test-card', commits: ['Make the about page a test card', 'Start where the reader left off'] },
        { kind: 'merge', branch: 'fix/thing', commits: ['Fix the thing'] },
      ],
      compareUrl: 'https://github.com/TomasEkeli/Fjernsyn/compare/v0.1.5...v0.1.9',
    })

    expect(notes).toBe([
      '### feature/test-card',
      '',
      '- Make the about page a test card',
      '- Start where the reader left off',
      '',
      '### fix/thing',
      '',
      '- Fix the thing',
      '',
      '**Full changelog**: https://github.com/TomasEkeli/Fjernsyn/compare/v0.1.5...v0.1.9',
      '',
    ].join('\n'))
  })

  it("names an upstream sync without listing upstream's commits", () => {
    const notes = formatReleaseNotes({
      entries: [{ kind: 'merge', branch: 'sync/upstream-2026-10-01', commits: ['Resolve the README as ours'] }],
      compareUrl: null,
    })

    expect(notes).toBe([
      '### Upstream FreeTube',
      '',
      "- FreeTube's development branch merged in (`sync/upstream-2026-10-01`)",
      '',
    ].join('\n'))
  })

  it('gathers commits made straight on main at the end', () => {
    const notes = formatReleaseNotes({
      entries: [
        { kind: 'commit', subject: 'Point contributors to the projects Fjernsyn builds on' },
        { kind: 'merge', branch: 'docs/readme', commits: ['Say it better'] },
      ],
      compareUrl: null,
    })

    expect(notes).toBe([
      '### docs/readme',
      '',
      '- Say it better',
      '',
      '### Other changes',
      '',
      '- Point contributors to the projects Fjernsyn builds on',
      '',
    ].join('\n'))
  })

  it('says so when this is the first release, rather than listing all history', () => {
    expect(formatReleaseNotes({ entries: null, compareUrl: null })).toBe('The first release of Fjernsyn.\n')
  })

  it('says so when nothing changed since the last release, as a rerun would find', () => {
    expect(formatReleaseNotes({ entries: [], compareUrl: null })).toBe('No changes since the last release.\n')
  })
})
