import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { baseFileName, readSyncFile } from '../../renderer/helpers/keptBackup'
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

    const first = runKeeperJob({ type: 'build', sections, header: HEADER, base: null, lastContentHash: null })

    const { newBase } = first
    const baseText = gunzipSync(newBase.gz).toString('utf8')
    expect(baseText).toBe(newBase.text)
    expect(hashOf(baseText)).toBe(newBase.sha256)
    expect(newBase.file).toBe(baseFileName(newBase.sha256))
    expect(JSON.parse(baseText)).toMatchObject({ machineName: 'MACHINE-w', sections: { history: [entry('h1', 1)] } })

    expect(first.syncHash).toBe(hashOf(first.syncText))
    expect(readSyncFile(first.syncText)).toEqual({
      ok: true,
      header: { formatVersion: 1, ...HEADER },
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
})
