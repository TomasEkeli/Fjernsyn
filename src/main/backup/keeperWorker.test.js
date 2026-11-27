import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { writeBackup } from '../../renderer/helpers/backup'
import { baseFileName, readArchiveHeader, writeSyncFile } from '../../renderer/helpers/keptBackup'
import { runKeeperJob } from './keeperWorker'

// The worker's entry point, run inline: the same function the worker thread runs

const HEADER = { appVersion: '0.1.0', installationId: 'installation-w', machineName: 'MACHINE-w' }

const PROFILE = { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] }

const hashOf = text => createHash('sha256').update(text).digest('hex')

function entry(id, timeWatched) {
  return { _id: id, videoId: `video-${id}`, title: `Video ${id}`, author: 'Synthetic Channel', authorId: 'UCsynthetic', timeWatched, type: 'video' }
}

describe('runKeeperJob', () => {
  it('turns sections into an archive when there is none, then into the state records against it', () => {
    const sections = { profiles: [PROFILE], history: [entry('h1', 1)], settings: [{ _id: 'maxVolume', value: 100 }] }
    const cut = { 'installation-w': 7 }

    const first = runKeeperJob({ type: 'build', sections, header: HEADER, cut, archive: null, at: 5, lastContentHash: null })

    const { newArchive } = first
    const text = gunzipSync(newArchive.gz).toString('utf8')
    expect(text).toBe(newArchive.text)
    expect(hashOf(text)).toBe(newArchive.sha256)
    expect(newArchive.file).toBe(baseFileName(newArchive.sha256))
    expect(JSON.parse(text)).toMatchObject({ machineName: 'MACHINE-w', sections: { history: [entry('h1', 1)] } })
    expect(readArchiveHeader(text)).toMatchObject({ ok: true, cut })

    // A new archive has every state field, so nothing is a delta against it
    expect(first.records).toEqual({})

    const archive = { sha256: newArchive.sha256, text }
    const second = runKeeperJob({
      type: 'build',
      sections: { ...sections, history: [entry('h1', 1), entry('h2', 2)] },
      header: HEADER,
      archive,
      at: 9,
      lastContentHash: first.contentHash,
    })

    expect(second).toMatchObject({ unchanged: false, newArchive: null })
    expect(second.records).toEqual({ 'history/h2': { at: 9, fields: entry('h2', 2) } })

    // the content as last written: nothing to write
    expect(runKeeperJob({ type: 'build', sections, header: HEADER, archive, at: 9, lastContentHash: first.contentHash }))
      .toEqual({ contentHash: first.contentHash, unchanged: true })

    // past the threshold: a new archive, whatever the content did
    expect(runKeeperJob({ type: 'build', sections, header: HEADER, archive, at: 9, lastContentHash: first.contentHash, wantArchive: true }).newArchive)
      .not.toBeNull()
  })

  describe('merge', () => {
    /** A history entry with every field a restore asks for */
    function watched(id, timeWatched) {
      return { ...entry(id, timeWatched), published: 1700000000000, description: '', viewCount: 10, lengthSeconds: 60, watchProgress: 30, isLive: false }
    }

    /** The folder's state as a sync file on a base, as a machine on the old layout wrote it */
    function folderState(sections) {
      const header = { ...HEADER, machineName: 'MACHINE-z' }
      const baseText = writeBackup({ ...header, sections })
      const sha256 = hashOf(baseText)

      return { syncText: writeSyncFile({ ...header, base: { file: baseFileName(sha256), sha256 }, changes: {} }), baseText }
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
