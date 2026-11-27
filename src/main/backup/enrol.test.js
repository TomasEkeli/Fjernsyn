import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appliedFromCut, capPending, ensureOwnIdentity, firstMeeting } from './enrol'
import { MACHINE_BOUND_SETTINGS } from './machineBound'
import { writeBackup } from '../../renderer/helpers/backup'
import { baseFileName, SYNC_FILE_NAME, writeArchive, writeSyncFile } from '../../renderer/helpers/keptBackup'

// A folder of files and the data folder's sections, synthetic throughout.

const HEADER_Z = { appVersion: '0.1.0', installationId: 'installation-z', machineName: 'MACHINE-z' }

const MAIN_PROFILE = { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] }
const FAVOURITES = { _id: 'favorites', playlistName: 'Favorites', videos: [], protected: true }

let folder

beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-enrol-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

/** An archive of another machine's, gzipped, in the folder */
function writeForeignArchive(sections, cut = {}) {
  const text = writeArchive({ ...HEADER_Z, cut, sections })
  const hash = createHash('sha256').update(text).digest('hex')
  writeFileSync(path.join(folder, baseFileName(hash)), gzipSync(text))
  return hash
}

/** What an archive of these sections would be named */
function nameOf(sections, cut) {
  return baseFileName(createHash('sha256').update(writeArchive({ ...HEADER_Z, cut, sections })).digest('hex'))
}

/**
 * The folder as the version before this one left it: a base the old way,
 * with no cut, and `fjernsyn-sync.json` with the changes since it
 */
function writeOldLayout(base, changes) {
  const text = writeBackup({ ...HEADER_Z, sections: base })
  const hash = createHash('sha256').update(text).digest('hex')
  writeFileSync(path.join(folder, baseFileName(hash)), gzipSync(text))
  writeFileSync(path.join(folder, SYNC_FILE_NAME), writeSyncFile({ ...HEADER_Z, base: { file: baseFileName(hash), sha256: hash }, changes }))
  return hash
}

function meet(sections, extra = {}) {
  return firstMeeting({ folder, fileSystem: fs, sections, machineBound: MACHINE_BOUND_SETTINGS, ...extra })
}

describe('the applied ranges an archive seeds', () => {
  it('has every sequence number each machine wrote up to the cut, which the archive has folded in already', () => {
    expect(appliedFromCut({ 'installation-z': 4, 'installation-y': 9 }))
      .toEqual({ 'installation-z': [[1, 4]], 'installation-y': [[1, 9]] })
  })

  it('names no machine whose cut is nothing, so no range claims a sequence number no one wrote', () => {
    expect(appliedFromCut({ 'installation-z': 0 })).toEqual({})
  })

  it('joins what this machine already has, and takes none of it away', () => {
    expect(appliedFromCut({ 'installation-z': 4 }, { 'installation-z': [[7, 9]], 'installation-a': [[1, 2]] }))
      .toEqual({ 'installation-z': [[1, 4], [7, 9]], 'installation-a': [[1, 2]] })

    expect(appliedFromCut({ 'installation-z': 4 }, { 'installation-z': [[5, 9]] }))
      .toEqual({ 'installation-z': [[1, 9]] })
  })
})

describe('the pending log\'s cap', () => {
  const at = 1764160000000
  const event = when => ({ at: when, type: 'later.added', key: `later/${when}`, data: {} })

  it('drops the oldest beyond ten thousand, and keeps the newest in the order they were made', () => {
    const events = Array.from({ length: 10_002 }, (ignored, index) => event(at + index))
    const kept = capPending(events, at)

    expect(kept).toHaveLength(10_000)
    expect(kept[0]).toEqual(event(at + 2))
    expect(kept[9_999]).toEqual(event(at + 10_001))
  })

  it('drops an intent more than thirty days old, however few there are', () => {
    expect(capPending([event(at - 31 * 24 * 60 * 60_000), event(at)], at)).toEqual([event(at)])
  })

  it('keeps one made thirty days ago to the minute', () => {
    expect(capPending([event(at - 30 * 24 * 60 * 60_000)], at)).toHaveLength(1)
  })
})

describe('meeting a folder for the first time', () => {
  it('removes nothing local', async () => {
    writeForeignArchive({ later: [{ _id: 'theirs', videoId: 'theirs', position: 1 }] })

    const { toApply } = await meet({ later: [{ _id: 'ours', videoId: 'ours', position: 1 }] })

    expect(toApply.later.remove).toEqual([])
    expect(toApply.later.put).toEqual([{ _id: 'theirs', videoId: 'theirs', position: 1 }])
  })

  it('joins the default profile and the default playlists, and doubles neither', async () => {
    writeForeignArchive({
      profiles: [{ ...MAIN_PROFILE, subscriptions: [{ id: 'UCtheirs', name: 'Theirs' }] }],
      playlists: [FAVOURITES],
    })

    const { toApply } = await meet({ profiles: [MAIN_PROFILE], playlists: [FAVOURITES] })

    expect(toApply.profiles.put.map(({ _id }) => _id)).toEqual(['allChannels'])
    expect(toApply.playlists).toBeUndefined()
  })

  it('never writes a machine-bound setting from another machine', async () => {
    writeForeignArchive({ settings: [{ _id: 'proxyHostname', value: 'elsewhere' }, { _id: 'playbackRate', value: 2 }] })

    const { toApply } = await meet({ settings: [] })

    expect(toApply.settings.put).toEqual([{ _id: 'playbackRate', value: 2 }])
  })

  it('seeds the applied ranges from the cut of the archive it took', async () => {
    writeForeignArchive({ later: [] }, { 'installation-z': 12 })

    expect((await meet({ later: [] })).applied).toEqual({ 'installation-z': [[1, 12]] })
  })

  it('takes the archive that has folded the most in, so least is left to apply', async () => {
    const most = writeForeignArchive({ later: [{ _id: 'late', videoId: 'late', position: 1 }] }, { 'installation-z': 9 })

    // The one that folded less is made to sort first, so that reading the
    // folder's archives in name order would land on the wrong one
    let early = 0
    let less
    do {
      early += 1
      less = { later: [{ _id: 'early', videoId: 'early', position: early }] }
    } while (nameOf(less, { 'installation-z': 2 }) >= baseFileName(most))

    writeForeignArchive(less, { 'installation-z': 2 })

    const { archive, toApply } = await meet({ later: [] })

    expect(archive).toBe(most)
    expect(toApply.later.put.map(({ _id }) => _id)).toEqual(['late'])
  })

  it('leaves an archive that does not match the hash in its name alone', async () => {
    const hash = writeForeignArchive({ later: [{ _id: 'theirs', videoId: 'theirs', position: 1 }] })
    writeFileSync(path.join(folder, baseFileName(hash)), gzipSync(writeArchive({ ...HEADER_Z, cut: { 'installation-z': 3 }, sections: { later: [] } })))

    expect(await meet({ later: [] })).toEqual({ archive: null, toApply: {}, applied: {} })
  })

  it('takes a folder still in the old layout as its base with the changes the sync file has since it', async () => {
    writeOldLayout(
      { later: [{ _id: 'inthebase0', videoId: 'inthebase0', position: 1 }], settings: [{ _id: 'playbackRate', value: 1 }] },
      {
        later: { put: [{ _id: 'sincethebas', videoId: 'sincethebas', position: 2 }], remove: ['inthebase0'] },
        settings: { put: [{ _id: 'playbackRate', value: 2 }], remove: [] },
      }
    )

    const { toApply, applied } = await meet({ later: [], settings: [] })

    expect(toApply.later.put.map(({ _id }) => _id)).toEqual(['sincethebas'])
    expect(toApply.settings.put).toEqual([{ _id: 'playbackRate', value: 2 }])
    expect(applied).toEqual({})
  })

  it('leaves a sync file that is against another base alone, since the new layout has what it held', async () => {
    writeOldLayout({ later: [{ _id: 'inthebase0', videoId: 'inthebase0', position: 1 }] }, { later: { put: [{ _id: 'sincethebas', videoId: 'sincethebas', position: 2 }], remove: [] } })
    writeForeignArchive({ later: [{ _id: 'archived000', videoId: 'archived000', position: 1 }] }, { 'installation-z': 6 })

    const { toApply } = await meet({ later: [] })

    expect(toApply.later.put.map(({ _id }) => _id)).toEqual(['archived000'])
  })

  it('leaves this machine as it is when the folder has no archive at all', async () => {
    expect(await meet({ later: [] }, { applied: { 'installation-a': [[1, 3]] } }))
      .toEqual({ archive: null, toApply: {}, applied: { 'installation-a': [[1, 3]] } })
  })
})

describe('this machine\'s own identity', () => {
  const same = { installationId: 'installation-a', hostName: 'DESKTOP', lastHostName: 'DESKTOP' }
  const mint = () => 'installation-new'
  const line = seq => ({ seq, at: 1764160000000 + seq, by: 'installation-a', type: 'later.added', key: 'later/one', data: {} })

  it('mints a new installation id when the host name has changed', async () => {
    expect(await ensureOwnIdentity({ ...same, hostName: 'LAPTOP', mint })).toBe('installation-new')
  })

  it('mints a new installation id when its own segment shows a sequence number twice, which only a second machine on this id writes', async () => {
    expect(await ensureOwnIdentity({ ...same, ownSegment: [line(1), line(2), line(2)], mint })).toBe('installation-new')
  })

  it('keeps the id it has when the host name is the same and every sequence number in its segment is its own', async () => {
    expect(await ensureOwnIdentity({ ...same, ownSegment: [line(1), line(2), line(3)], mint })).toBe('installation-a')
  })

  it('keeps the id it has when no host name was ever recorded, since nothing says the folder moved', async () => {
    expect(await ensureOwnIdentity({ ...same, lastHostName: null, mint })).toBe('installation-a')
  })
})
