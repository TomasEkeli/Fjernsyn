import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Datastore from '@seald-io/nedb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { backupsFolder, ensureInstallationId, restoreBackup, SAFETY_COPIES_KEPT, safetyCopyName } from './restore'

// The restore on a temporary data folder, with real datastores and files

const DATASTORE_FILES = {
  settings: 'settings',
  profiles: 'profiles',
  playlists: 'playlists',
  history: 'history',
  searchHistory: 'search-history',
  channels: 'channels',
  aiVerdicts: 'ai-verdicts',
  later: 'later',
}

const MAIN_PROFILE = { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] }

let dataFolder

beforeEach(() => {
  dataFolder = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-restore-'))
})

afterEach(() => {
  rmSync(dataFolder, { recursive: true, force: true })
})

async function openDatastores() {
  const datastores = {}

  for (const [name, file] of Object.entries(DATASTORE_FILES)) {
    datastores[name] = new Datastore({ filename: path.join(dataFolder, `${file}.db`) })
    await datastores[name].loadDatabaseAsync()
  }

  return datastores
}

/** Every record in a datastore as written to disk, read fresh from its file */
async function onDisk(name, query = {}) {
  const fresh = new Datastore({ filename: path.join(dataFolder, `${DATASTORE_FILES[name]}.db`) })
  await fresh.loadDatabaseAsync()
  return fresh.findAsync(query).sort({ _id: 1 })
}

/**
 * @param {Awaited<ReturnType<typeof openDatastores>>} datastores
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {object} [options.fileSystem]
 */
function setup(datastores, { now = new Date(2026, 9, 4, 16, 30, 5), fileSystem } = {}) {
  const relaunch = vi.fn()
  const restore = request => restoreBackup({ datastores, dataFolder, relaunch, now: () => now, fileSystem }, request)
  return { relaunch, restore }
}

/** Fills the datastores the way a used app has them */
async function populate(datastores) {
  await datastores.profiles.insertAsync([MAIN_PROFILE, { ...MAIN_PROFILE, _id: 'old', name: 'Old' }])
  await datastores.history.insertAsync([{ _id: 'h1', videoId: 'oldVideo001', title: 'Old' }])
  await datastores.playlists.insertAsync([{ _id: 'favorites', playlistName: 'Favorites', protected: true, videos: [] }])
  await datastores.searchHistory.insertAsync([{ _id: 'old search', lastUpdatedAt: 1 }])
  await datastores.channels.insertAsync([{ _id: 'UCold', channelTags: ['old'] }])
  await datastores.aiVerdicts.insertAsync([{ _id: 'oldVideo001', ai: true, checkedAt: 1 }])
  await datastores.later.insertAsync([{ _id: 'oldVideo001', videoId: 'oldVideo001', title: 'Old', position: 0, alarm: null }])
  await datastores.settings.insertAsync([
    { _id: 'maxVolume', value: 300 },
    { _id: 'baseTheme', value: 'dark' },
    { _id: 'proxyHostname', value: '10.0.0.1' },
    { _id: 'screenshotFolderPath', value: '/home/me/shots' },
    { _id: 'ytDlpExecutablePath', value: '/opt/yt-dlp' },
    { _id: 'installationId', value: 'this-installation' },
    { _id: 'bounds', value: { x: 1, y: 2, width: 800, height: 600 } },
  ])
}

const SAFETY_COPY = '{\n  "format": "fjernsyn-backup"\n}\n'

describe('restoreBackup', () => {
  it('names the safety copy by the local time, so that the names sort by time', () => {
    expect(safetyCopyName(new Date(2026, 9, 4, 6, 3, 9))).toBe('before-restore-2026-10-04-060309.json')
    expect(safetyCopyName(new Date(2026, 0, 31, 23, 59, 59))).toBe('before-restore-2026-01-31-235959.json')
  })

  it('writes the safety copy into backups/ in the data folder, creating it', async () => {
    const datastores = await openDatastores()
    const { restore } = setup(datastores)

    const result = await restore({ safetyCopy: SAFETY_COPY, sections: {} })

    const expected = path.join(dataFolder, 'backups', 'before-restore-2026-10-04-163005.json')
    expect(result).toEqual({ ok: true, safetyCopyPath: expected })
    expect(backupsFolder(dataFolder)).toBe(path.join(dataFolder, 'backups'))
    expect(readFileSync(expected, 'utf8')).toBe(SAFETY_COPY)
  })

  it(`keeps only the newest ${SAFETY_COPIES_KEPT} safety copies, and nothing else in the folder is touched`, async () => {
    const folder = path.join(dataFolder, 'backups')
    mkdirSync(folder)
    for (const name of [
      'before-restore-2026-10-01-120000.json',
      'before-restore-2025-12-31-235959.json',
      'before-restore-2026-10-03-080000.json',
      'before-restore-2026-10-02-090000.json',
      'fjernsyn-backup-2026-09-30.json',
      'notes.txt',
    ]) {
      writeFileSync(path.join(folder, name), 'x')
    }

    const datastores = await openDatastores()
    const { restore } = setup(datastores)
    await restore({ safetyCopy: SAFETY_COPY, sections: {} })

    expect(readdirSync(folder).sort()).toEqual([
      'before-restore-2026-10-02-090000.json',
      'before-restore-2026-10-03-080000.json',
      'before-restore-2026-10-04-163005.json',
      'fjernsyn-backup-2026-09-30.json',
      'notes.txt',
    ])
  })

  it('replaces each section in the request, _ids kept, and leaves the others alone', async () => {
    const datastores = await openDatastores()
    await populate(datastores)
    const { restore } = setup(datastores)

    const history = [
      { _id: 'n1', videoId: 'newVideo001', title: 'New', watchProgress: 10 },
      { _id: 'n2', videoId: 'newVideo002', title: 'Newer', watchProgress: 0 },
    ]
    const result = await restore({
      safetyCopy: SAFETY_COPY,
      sections: {
        profiles: [MAIN_PROFILE],
        history,
        searchHistory: [],
      },
    })

    expect(result.ok).toBe(true)

    // the removed profile is gone: a restore replaces, it does not merge
    expect(await onDisk('profiles')).toEqual([MAIN_PROFILE])
    expect(await onDisk('history')).toEqual(history)
    expect(await onDisk('searchHistory')).toEqual([])

    expect(await onDisk('playlists')).toEqual([{ _id: 'favorites', playlistName: 'Favorites', protected: true, videos: [] }])
    expect(await onDisk('channels')).toEqual([{ _id: 'UCold', channelTags: ['old'] }])
    expect(await onDisk('aiVerdicts')).toEqual([{ _id: 'oldVideo001', ai: true, checkedAt: 1 }])
    expect((await onDisk('later')).map(item => item._id)).toEqual(['oldVideo001'])
  })

  it('replaces every section a whole backup holds', async () => {
    const datastores = await openDatastores()
    await populate(datastores)
    const { restore } = setup(datastores)

    const sections = {
      profiles: [MAIN_PROFILE],
      history: [{ _id: 'n1', videoId: 'newVideo001', title: 'New' }],
      playlists: [{ _id: 'p1', playlistName: 'Mine', videos: [{ videoId: 'a', title: 'A', lengthSeconds: 1, timeAdded: 1 }] }],
      later: [{ _id: 'newVideo002', videoId: 'newVideo002', title: 'Armed', position: 0, alarm: { at: 5, armedAt: 1 } }],
      searchHistory: [{ _id: 'new search', lastUpdatedAt: 2 }],
      channels: [{ _id: 'UCnew', videoSamples: { titles: ['x'] } }],
      aiVerdicts: [{ _id: 'newVideo001', ai: false, checkedAt: 2 }],
    }
    await restore({ safetyCopy: SAFETY_COPY, sections })

    for (const [name, records] of Object.entries(sections)) {
      expect(await onDisk(name), name).toEqual(records)
    }
  })

  it('upserts the settings rather than clearing them: a setting the backup does not mention keeps its value', async () => {
    const datastores = await openDatastores()
    await populate(datastores)
    const { restore } = setup(datastores)

    await restore({
      safetyCopy: SAFETY_COPY,
      sections: { settings: [{ _id: 'maxVolume', value: 1000 }, { _id: 'profileOrder', value: ['b', 'a'] }] },
    })

    const settings = Object.fromEntries((await onDisk('settings')).map(({ _id, value }) => [_id, value]))
    expect(settings.maxVolume).toBe(1000)
    expect(settings.profileOrder).toEqual(['b', 'a'])
    expect(settings.baseTheme).toBe('dark')
    expect(settings.proxyHostname).toBe('10.0.0.1')
  })

  it('refuses the settings only main may write, and what belongs to this data folder', async () => {
    const datastores = await openDatastores()
    await populate(datastores)
    const { restore } = setup(datastores)

    const result = await restore({
      safetyCopy: SAFETY_COPY,
      sections: {
        settings: [
          { _id: 'screenshotFolderPath', value: '/tmp/evil' },
          { _id: 'ytDlpExecutablePath', value: '/tmp/evil' },
          { _id: 'ytDlpDownloadFolder', value: '/tmp/evil' },
          { _id: 'installationId', value: 'another-installation' },
          { _id: 'bounds', value: { x: 0, y: 0, width: 1, height: 1 } },
          { _id: 'maxVolume', value: 500 },
        ],
      },
    })

    expect(result.ok).toBe(true)

    const settings = Object.fromEntries((await onDisk('settings')).map(({ _id, value }) => [_id, value]))
    expect(settings.screenshotFolderPath).toBe('/home/me/shots')
    expect(settings.ytDlpExecutablePath).toBe('/opt/yt-dlp')
    expect(settings).not.toHaveProperty('ytDlpDownloadFolder')
    expect(settings.installationId).toBe('this-installation')
    expect(settings.bounds).toEqual({ x: 1, y: 2, width: 800, height: 600 })
    expect(settings.maxVolume).toBe(500)
  })

  it('compacts what it wrote, so the files hold only the new records', async () => {
    const datastores = await openDatastores()
    await populate(datastores)
    const { restore } = setup(datastores)

    await restore({ safetyCopy: SAFETY_COPY, sections: { profiles: [MAIN_PROFILE] } })

    const lines = readFileSync(path.join(dataFolder, 'profiles.db'), 'utf8').split('\n').filter(line => line !== '')
    expect(lines.map(line => JSON.parse(line))).toEqual([MAIN_PROFILE])
  })

  it('relaunches last, once everything is written', async () => {
    const datastores = await openDatastores()
    const { restore, relaunch } = setup(datastores)
    relaunch.mockImplementation(() => {
      // what the relaunch would see if it ran now
      relaunch.sawProfiles = readFileSync(path.join(dataFolder, 'profiles.db'), 'utf8')
    })

    await restore({ safetyCopy: SAFETY_COPY, sections: { profiles: [MAIN_PROFILE] } })

    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(relaunch.sawProfiles.trim())).toEqual(MAIN_PROFILE)
  })

  describe('a failure', () => {
    it('refuses a malformed request before writing anything', async () => {
      const datastores = await openDatastores()
      await populate(datastores)
      const { restore, relaunch } = setup(datastores)

      for (const request of [
        null,
        { sections: {} },
        { safetyCopy: '', sections: {} },
        { safetyCopy: SAFETY_COPY },
        { safetyCopy: SAFETY_COPY, sections: [] },
        { safetyCopy: SAFETY_COPY, sections: { subscriptionCache: [] } },
        { safetyCopy: SAFETY_COPY, sections: { history: {} } },
        { safetyCopy: SAFETY_COPY, sections: { history: [null] } },
        { safetyCopy: SAFETY_COPY, sections: { settings: [{ value: 1 }] } },
      ]) {
        const result = await restore(request)
        expect(result.ok, JSON.stringify(request)).toBe(false)
        expect(result.safetyCopyPath).toBeNull()
      }

      expect(relaunch).not.toHaveBeenCalled()
      expect(readdirSync(dataFolder)).not.toContain('backups')
      expect((await onDisk('profiles')).length).toBe(2)
    })

    it('stops before replacing anything when the safety copy cannot be written', async () => {
      const datastores = await openDatastores()
      await populate(datastores)
      const fileSystem = { ...fs, writeFile: vi.fn(async () => { throw new Error('disk full') }) }
      const { restore, relaunch } = setup(datastores, { fileSystem })

      const result = await restore({ safetyCopy: SAFETY_COPY, sections: { profiles: [] } })

      expect(result).toEqual({ ok: false, error: 'Could not write the safety copy: disk full', safetyCopyPath: null })
      expect(relaunch).not.toHaveBeenCalled()
      expect((await onDisk('profiles')).length).toBe(2)
    })

    it('stops where a section fails, says so with the safety copy, and does not relaunch', async () => {
      const datastores = await openDatastores()
      await populate(datastores)
      const { restore, relaunch } = setup(datastores)

      // The datastore refuses a field name that begins with $
      const result = await restore({
        safetyCopy: SAFETY_COPY,
        sections: {
          profiles: [MAIN_PROFILE],
          history: [{ _id: 'bad', videoId: 'x', $where: 'nope' }],
          channels: [{ _id: 'UCnew' }],
        },
      })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/\$/)
      expect(result.safetyCopyPath).toBe(path.join(dataFolder, 'backups', 'before-restore-2026-10-04-163005.json'))
      expect(relaunch).not.toHaveBeenCalled()

      // what came before the failure is replaced, what came after is not
      expect(await onDisk('profiles')).toEqual([MAIN_PROFILE])
      expect(await onDisk('channels')).toEqual([{ _id: 'UCold', channelTags: ['old'] }])
    })

    it('goes on when an old safety copy cannot be removed', async () => {
      const folder = path.join(dataFolder, 'backups')
      mkdirSync(folder)
      for (const day of ['01', '02', '03']) {
        writeFileSync(path.join(folder, `before-restore-2026-10-${day}-120000.json`), 'x')
      }

      const datastores = await openDatastores()
      const fileSystem = { ...fs, rm: vi.fn(async () => { throw new Error('busy') }) }
      const { restore, relaunch } = setup(datastores, { fileSystem })
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await restore({ safetyCopy: SAFETY_COPY, sections: { profiles: [MAIN_PROFILE] } })

      expect(result.ok).toBe(true)
      expect(relaunch).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalled()
      consoleError.mockRestore()
    })
  })
})

describe('ensureInstallationId', () => {
  it('makes one when there is none, and keeps it', async () => {
    const { settings } = await openDatastores()

    const made = await ensureInstallationId(settings, () => 'made-once')
    const again = await ensureInstallationId(settings, () => 'made-twice')

    expect(made).toBe('made-once')
    expect(again).toBe('made-once')
    expect(await onDisk('settings', { _id: 'installationId' })).toEqual([{ _id: 'installationId', value: 'made-once' }])
  })

  it('is a random UUID by default', async () => {
    const { settings } = await openDatastores()

    expect(await ensureInstallationId(settings)).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  })

  it('replaces one that is empty', async () => {
    const { settings } = await openDatastores()
    await settings.insertAsync({ _id: 'installationId', value: '' })

    expect(await ensureInstallationId(settings, () => 'fresh')).toBe('fresh')
  })
})
