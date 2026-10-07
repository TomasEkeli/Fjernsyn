import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { baseFileName, readSyncFile, writeSyncFile } from '../../renderer/helpers/keptBackup'
import { runKeeperJob } from './keeperWorker'

// The worker's entry point, run inline: the same function the worker thread runs

const HEADER = { appVersion: '0.1.0', installationId: 'installation-w', machineName: 'MACHINE-w' }

const PROFILE = { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] }

const hashOf = text => createHash('sha256').update(text).digest('hex')

function entry(id, timeWatched) {
  return { _id: id, videoId: `video-${id}`, title: `Video ${id}`, author: 'Synthetic Channel', authorId: 'UCsynthetic', timeWatched, type: 'video' }
}

describe('runKeeperJob', () => {
  it('turns sections into a sync file: on a new base when there is none, then as changes against it', () => {
    const sections = { profiles: [PROFILE], history: [entry('h1', 1)], settings: [{ _id: 'maxVolume', value: 100 }] }

    const lineage = ['0123456789abcdef']
    const first = runKeeperJob({ type: 'build', sections, header: HEADER, lineage, base: null, lastContentHash: null })

    const { newBase } = first
    const baseText = gunzipSync(newBase.gz).toString('utf8')
    expect(baseText).toBe(newBase.text)
    expect(hashOf(baseText)).toBe(newBase.sha256)
    expect(newBase.file).toBe(baseFileName(newBase.sha256))
    expect(JSON.parse(baseText)).toMatchObject({ machineName: 'MACHINE-w', sections: { history: [entry('h1', 1)] } })

    expect(first.syncHash).toBe(hashOf(first.syncText))
    expect(readSyncFile(first.syncText)).toEqual({
      ok: true,
      header: { formatVersion: 1, ...HEADER, lineage },
      base: { file: newBase.file, sha256: newBase.sha256 },
      changes: {},
    })

    const base = { file: newBase.file, sha256: newBase.sha256, text: baseText }
    const second = runKeeperJob({
      type: 'build',
      sections: { ...sections, history: [entry('h1', 1), entry('h2', 2)] },
      header: HEADER,
      base,
      lastContentHash: first.contentHash,
    })

    expect(second).toMatchObject({ unchanged: false, newBase: null })
    expect(readSyncFile(second.syncText)).toMatchObject({ base: { file: newBase.file }, changes: { history: { put: [entry('h2', 2)], remove: [] } } })

    // the content as last written: nothing to write
    expect(runKeeperJob({ type: 'build', sections, header: HEADER, base, lastContentHash: first.contentHash }))
      .toEqual({ contentHash: first.contentHash, unchanged: true })
  })

  describe('merge', () => {
    /** A history entry with every field a restore asks for */
    function watched(id, timeWatched) {
      return { ...entry(id, timeWatched), published: 1700000000000, description: '', viewCount: 10, lengthSeconds: 60, watchProgress: 30, isLive: false }
    }

    /** The folder's state as a sync file on a base, as another machine wrote it */
    function folderState(sections) {
      const built = runKeeperJob({ type: 'build', sections, header: { ...HEADER, machineName: 'MACHINE-z' }, base: null, lastContentHash: null })
      return { syncText: built.syncText, baseText: gunzipSync(built.newBase.gz).toString('utf8') }
    }

    const ours = { profiles: [PROFILE], history: [watched('h1', 1)], settings: [{ _id: 'maxVolume', value: 100 }] }

    function merge(theirs, extra = {}) {
      return runKeeperJob({ type: 'merge', theirs, ancestor: null, sections: ours, header: HEADER, machineBound: ['proxyHostname'], wantSafetyCopy: true, ...extra })
    }

    it('gives what to apply to make ours the merge, never a machine-bound setting, and a safety copy of ours', () => {
      const theirs = folderState({
        profiles: [PROFILE],
        history: [watched('h2', 2)],
        settings: [{ _id: 'maxVolume', value: 100 }, { _id: 'proxyHostname', value: '10.9.9.9' }],
      })

      const result = merge(theirs)

      expect(result).toMatchObject({ ok: true, conflicts: 0 })
      expect(result.toApply).toEqual({ history: { put: [watched('h2', 2)], remove: [] } })
      expect(JSON.parse(result.safetyCopy).sections.history).toEqual([watched('h1', 1)])
      expect(result.mergedContentHash).not.toBe(result.theirContentHash)
    })

    it('writes no safety copy when not wanted, or when nothing changes here', () => {
      expect(merge(folderState({ profiles: [PROFILE], history: [watched('h2', 2)] }), { wantSafetyCopy: false }).safetyCopy).toBeNull()

      expect(merge(folderState(ours))).toMatchObject({ ok: true, toApply: {}, safetyCopy: null })
    })

    it('refuses a sync file that does not read, or a base that is no backup', () => {
      const unknownBase = { file: baseFileName('f'.repeat(64)), sha256: 'f'.repeat(64) }

      expect(merge({ ...folderState(ours), syncText: '{' })).toEqual({ ok: false, reason: 'notJson' })
      expect(merge({ syncText: writeSyncFile({ ...HEADER, base: unknownBase, changes: {} }), baseText: '[]' }))
        .toEqual({ ok: false, reason: 'baseUnreadable' })
    })
  })
})
