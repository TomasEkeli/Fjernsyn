import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateUserData } from './userDataMigration'
import { nodeFileSystem } from './nodeFileSystem'
import { createMemoryFileSystem } from './testing/memoryFileSystem'

const ROOT = '/home/user/.config'
const OLD = `${ROOT}/FreeTube`
const NEW = `${ROOT}/Fjernsyn`
const PID = 4242

/**
 * An old folder the way a real one looks: the app's own files beside the
 * caches and storage Chromium keeps there.
 *
 * @param {ReturnType<typeof createMemoryFileSystem>} fs
 */
function populateOldFolder(fs) {
  fs.file(`${OLD}/settings.db`, 'settings')
  fs.file(`${OLD}/profiles.db`, 'profiles')
  fs.file(`${OLD}/playlists.db`, 'playlists')
  fs.file(`${OLD}/history.db`, 'history')
  fs.file(`${OLD}/search-history.db`, 'search history')
  fs.file(`${OLD}/subscription-cache.db`, 'subscription cache')
  fs.file(`${OLD}/channels.db`, 'channels')
  fs.file(`${OLD}/later.db`, 'later')
  fs.file(`${OLD}/bin/yt-dlp`, 'yt-dlp binary', 0o755)
  fs.file(`${OLD}/bin/ffmpeg`, 'ffmpeg binary', 0o755)
  fs.file(`${OLD}/experiment-replace-http-cache`)
  fs.file(`${OLD}/experiment-disable-hardware-acceleration`)
  fs.file(`${OLD}/player_cache/1234-abcd.js`, 'player')
  fs.file(`${OLD}/Cache/Cache_Data/index`, 'http cache')
  fs.file(`${OLD}/GPUCache/data_0`, 'gpu cache')
  fs.file(`${OLD}/Local Storage/leveldb/000003.log`, 'storage')
  fs.file(`${OLD}/Cookies`, 'cookies')
  fs.file(`${OLD}/Preferences`, '{}')
}

/**
 * What NeDB leaves when it opens a database that is not there: an empty file.
 *
 * @param {ReturnType<typeof createMemoryFileSystem>} fs
 */
function openEmptyDatabases(fs) {
  for (const name of ['settings', 'profiles', 'playlists', 'history', 'search-history', 'subscription-cache', 'channels', 'later']) {
    fs.file(`${NEW}/${name}.db`, '')
  }
}

/**
 * @param {object} [options]
 * @param {Parameters<typeof createMemoryFileSystem>[0]['failOn']} [options.failOn]
 * @param {string[]} [options.sources]
 * @param {(pid: number) => boolean} [options.isAlive]
 * @param {(ms: number, clock: { now: number }) => void} [options.onSleep] what happens while this process waits
 */
function setup({ failOn, sources = ['FreeTube'], isAlive = () => false, onSleep = () => {} } = {}) {
  const clock = { now: 1_000_000 }
  const fs = createMemoryFileSystem({ failOn, now: () => clock.now })
  const sleeps = []

  const migrate = () => migrateUserData({
    root: ROOT,
    sources,
    target: 'Fjernsyn',
    fs,
    pid: PID,
    isAlive,
    now: () => clock.now,
    sleep: (ms) => {
      sleeps.push(ms)
      if (sleeps.length > 100_000) {
        throw new Error('waited forever')
      }
      clock.now += ms
      onSleep(ms, clock)
    },
  })

  return { fs, migrate, clock, sleeps }
}

/** @param {Record<string, unknown>} snapshot */
function databaseNames(snapshot) {
  return Object.keys(snapshot).filter(name => name.includes('.db')).sort()
}

describe('user data migration', () => {
  it('copies the databases, managed tools and experiment flags into an empty new folder', () => {
    const { fs, migrate } = setup()
    populateOldFolder(fs)

    const result = migrate()

    expect(result).toEqual({ outcome: 'copied', from: 'FreeTube', linksCopiedAsFiles: [] })
    expect(Object.keys(fs.snapshot(NEW)).sort()).toEqual([
      'bin',
      'bin/ffmpeg',
      'bin/yt-dlp',
      'channels.db',
      'experiment-disable-hardware-acceleration',
      'experiment-replace-http-cache',
      'history.db',
      'later.db',
      'playlists.db',
      'profiles.db',
      'search-history.db',
      'settings.db',
      'subscription-cache.db',
    ])
    expect(fs.snapshot(NEW)['subscription-cache.db']).toEqual({ kind: 'file', data: 'subscription cache', mode: 0o644 })
  })

  it('keeps the managed tools executable', () => {
    const { fs, migrate } = setup()
    populateOldFolder(fs)

    migrate()

    expect(fs.snapshot(NEW)['bin/yt-dlp']).toEqual({ kind: 'file', data: 'yt-dlp binary', mode: 0o755 })
  })

  it('leaves the old folder exactly as it was', () => {
    const { fs, migrate } = setup()
    populateOldFolder(fs)
    const before = fs.snapshot(OLD)

    migrate()

    expect(fs.snapshot(OLD)).toEqual(before)
  })

  it('copies nothing when the new folder already has a database with something in it', () => {
    const { fs, migrate } = setup()
    populateOldFolder(fs)
    fs.file(`${NEW}/settings.db`, 'fjernsyn settings')

    const result = migrate()

    expect(result).toEqual({ outcome: 'skipped-target-has-data' })
    expect(Object.keys(fs.snapshot(NEW))).toEqual(['settings.db'])
    expect(fs.snapshot(NEW)['settings.db'].data).toBe('fjernsyn settings')
  })

  it('copies over the empty databases the app leaves when it starts without data', () => {
    const { fs, migrate } = setup()
    populateOldFolder(fs)
    openEmptyDatabases(fs)

    const result = migrate()

    expect(result.outcome).toBe('copied')
    expect(fs.snapshot(NEW)['profiles.db']).toEqual({ kind: 'file', data: 'profiles', mode: 0o644 })
  })

  it('does nothing, and does not fail, when there is no old folder', () => {
    const { fs, migrate } = setup()

    const result = migrate()

    expect(result).toEqual({ outcome: 'skipped-no-source' })
    expect(fs.snapshot(NEW)).toEqual({})
  })

  it('does nothing when the old folder holds no databases, or only empty ones', () => {
    const { fs, migrate } = setup()
    fs.file(`${OLD}/Preferences`, '{}')
    fs.file(`${OLD}/settings.db`, '')
    fs.file(`${OLD}/bin/yt-dlp`, 'yt-dlp binary', 0o755)

    expect(migrate()).toEqual({ outcome: 'skipped-no-source' })
    expect(fs.snapshot(NEW)).toEqual({})
  })

  it('copies when the new folder exists but holds only what Chromium made there', () => {
    const { fs, migrate } = setup()
    populateOldFolder(fs)
    fs.file(`${NEW}/Preferences`, '{}')
    fs.file(`${NEW}/GPUCache/data_0`, 'gpu cache')
    fs.file(`${NEW}/Cookies`, 'cookies')

    const result = migrate()

    expect(result.outcome).toBe('copied')
    expect(fs.snapshot(NEW)['profiles.db']).toEqual({ kind: 'file', data: 'profiles', mode: 0o644 })
    expect(fs.snapshot(NEW).Preferences).toEqual({ kind: 'file', data: '{}', mode: 0o644 })
  })

  it('takes the first source that has databases', () => {
    const { fs, migrate } = setup({ sources: ['FreeTube', 'Electron'] })
    fs.file(`${ROOT}/FreeTube/Preferences`, '{}')
    fs.file(`${ROOT}/Electron/settings.db`, 'dev settings')

    const result = migrate()

    expect(result.outcome).toBe('copied')
    expect(result.from).toBe('Electron')
    expect(fs.snapshot(NEW)['settings.db'].data).toBe('dev settings')
  })

  describe('symlinks', () => {
    it('copies a symlinked database as a symlink to the same file', () => {
      const { fs, migrate } = setup()
      fs.file('/home/user/Sync/history.db', 'synced history')
      fs.link(`${OLD}/history.db`, '/home/user/Sync/history.db')
      fs.file(`${OLD}/settings.db`, 'settings')

      migrate()

      expect(fs.snapshot(NEW)['history.db']).toEqual({ kind: 'symlink', target: '/home/user/Sync/history.db' })
    })

    it('points a relative symlink out of the old folder at the same file from the new one', () => {
      const { fs, migrate } = setup()
      fs.file('/home/user/Sync/history.db', 'synced history')
      fs.link(`${OLD}/history.db`, '../../Sync/history.db')

      migrate()

      expect(fs.snapshot(NEW)['history.db']).toEqual({ kind: 'symlink', target: '/home/user/Sync/history.db' })
    })

    it('points a relative symlink at a file in the old folder that is not copied at that file', () => {
      const { fs, migrate } = setup()
      fs.file(`${OLD}/sync/history.db`, 'synced history')
      fs.link(`${OLD}/history.db`, 'sync/history.db')

      migrate()

      expect(fs.snapshot(NEW)['history.db']).toEqual({ kind: 'symlink', target: `${OLD}/sync/history.db` })
    })

    it('keeps a relative symlink between copied files relative', () => {
      const { fs, migrate } = setup()
      populateOldFolder(fs)
      fs.link(`${OLD}/bin/ffprobe`, 'ffmpeg')

      migrate()

      expect(fs.snapshot(NEW)['bin/ffprobe']).toEqual({ kind: 'symlink', target: 'ffmpeg' })
    })

    it('copies the file a database links to when the system refuses to make a link', () => {
      const { fs, migrate } = setup({ failOn: (operation) => operation === 'symlink' && 'EPERM' })
      fs.file('/home/user/Sync/history.db', 'synced history')
      fs.link(`${OLD}/history.db`, '/home/user/Sync/history.db')

      const result = migrate()

      expect(result).toEqual({ outcome: 'copied', from: 'FreeTube', linksCopiedAsFiles: ['history.db'] })
      expect(fs.snapshot(NEW)['history.db']).toEqual({ kind: 'file', data: 'synced history', mode: 0o644 })
    })

    it('replaces a stray symlink at a destination rather than writing through it', () => {
      const { fs, migrate } = setup()
      populateOldFolder(fs)
      fs.file('/home/user/Sync/precious', 'precious')
      fs.link(`${NEW}/bin/yt-dlp`, '/home/user/Sync/precious')

      migrate()

      expect(fs.snapshot('/home/user/Sync').precious.data).toBe('precious')
      expect(fs.snapshot(NEW)['bin/yt-dlp']).toEqual({ kind: 'file', data: 'yt-dlp binary', mode: 0o755 })
    })
  })

  describe('failures', () => {
    it('reports a failure while copying, leaves the old folder intact, and leaves no databases', () => {
      const { fs, migrate } = setup({ failOn: (operation, filePath) => filePath.includes('profiles.db') })
      populateOldFolder(fs)
      const before = fs.snapshot(OLD)

      const result = migrate()

      expect(result.outcome).toBe('failed')
      expect(result.error).toBeInstanceOf(Error)
      expect(fs.snapshot(OLD)).toEqual(before)
      expect(databaseNames(fs.snapshot(NEW))).toEqual([])
    })

    it('reports a failure while moving the databases into place, and leaves none of them', () => {
      const { fs, migrate } = setup({ failOn: (operation, filePath) => operation === 'rename' && filePath.endsWith('/profiles.db') })
      populateOldFolder(fs)

      expect(migrate().outcome).toBe('failed')
      expect(databaseNames(fs.snapshot(NEW))).toEqual([])
    })

    it('tries again on the next launch, even after the app has run with empty databases', () => {
      let broken = true
      const { fs, migrate } = setup({ failOn: (operation, filePath) => broken && filePath.includes('profiles.db') })
      populateOldFolder(fs)

      expect(migrate().outcome).toBe('failed')
      openEmptyDatabases(fs)

      broken = false
      expect(migrate().outcome).toBe('copied')
      expect(fs.snapshot(NEW)['profiles.db']).toEqual({ kind: 'file', data: 'profiles', mode: 0o644 })
    })

    it('tries again over a half-copied tools folder', () => {
      let broken = true
      const { fs, migrate } = setup({ failOn: (operation, filePath) => broken && filePath.endsWith('/bin/ffmpeg') })
      populateOldFolder(fs)
      fs.link(`${OLD}/bin/ffprobe`, 'ffmpeg')

      expect(migrate().outcome).toBe('failed')

      broken = false
      expect(migrate().outcome).toBe('copied')
      expect(fs.snapshot(NEW)['bin/ffprobe']).toEqual({ kind: 'symlink', target: 'ffmpeg' })
      expect(fs.snapshot(NEW)['bin/ffmpeg'].data).toBe('ffmpeg binary')
    })

    it('copies again after a launch that died while moving the databases into place', () => {
      const { fs, migrate } = setup()
      populateOldFolder(fs)
      // What a launch killed part way through leaves: its marker, its lock,
      // and some of the databases
      fs.file(`${NEW}/.migration-incomplete`, '')
      fs.file(`${NEW}/.migration-lock`, '999')
      fs.file(`${NEW}/settings.db`, 'settings')

      const result = migrate()

      expect(result.outcome).toBe('copied')
      expect(databaseNames(fs.snapshot(NEW))).toEqual([
        'channels.db', 'history.db', 'later.db', 'playlists.db', 'profiles.db', 'search-history.db', 'settings.db', 'subscription-cache.db',
      ])
      expect(fs.snapshot(NEW)['.migration-incomplete']).toBeUndefined()
      expect(fs.snapshot(NEW)['.migration-lock']).toBeUndefined()
    })
  })

  describe('two launches at once', () => {
    it('waits for a live launch that is migrating, then finds its data and copies nothing', () => {
      const { fs, migrate, sleeps } = setup({
        isAlive: pid => pid === 777,
        onSleep: () => {
          if (sleeps.length === 3) {
            // the other launch finishes
            fs.file(`${NEW}/settings.db`, 'from the other launch')
            fs.rm(`${NEW}/.migration-lock`)
          }
        },
      })
      populateOldFolder(fs)
      fs.file(`${NEW}/.migration-lock`, '777')

      const result = migrate()

      expect(sleeps.length).toBe(3)
      expect(result).toEqual({ outcome: 'skipped-target-has-data' })
      expect(fs.snapshot(NEW)['settings.db'].data).toBe('from the other launch')
    })

    it('takes over the lock of a launch that is no longer running', () => {
      const { fs, migrate, sleeps } = setup({ isAlive: () => false })
      populateOldFolder(fs)
      fs.file(`${NEW}/.migration-lock`, '777')

      expect(migrate().outcome).toBe('copied')
      expect(sleeps).toEqual([])
    })

    it('takes over a lock held for longer than any migration takes', () => {
      const { fs, migrate, sleeps } = setup({ isAlive: () => true })
      populateOldFolder(fs)
      fs.file(`${NEW}/.migration-lock`, '777')

      expect(migrate().outcome).toBe('copied')
      expect(sleeps.length).toBeGreaterThan(0)
    })

    it('leaves no lock behind', () => {
      const { fs, migrate } = setup()
      populateOldFolder(fs)

      migrate()
      migrate()

      expect(fs.snapshot(NEW)['.migration-lock']).toBeUndefined()
    })
  })
})

describe('user data migration on the real filesystem', () => {
  /** @type {string | undefined} */
  let root

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('copies files, keeps modes and symlinks, and leaves caches behind', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-migration-'))
    const oldDir = path.join(root, 'FreeTube')
    const synced = path.join(root, 'Sync', 'history.db')

    mkdirSync(path.join(oldDir, 'bin'), { recursive: true })
    mkdirSync(path.join(oldDir, 'Cache'))
    mkdirSync(path.dirname(synced))
    writeFileSync(path.join(oldDir, 'settings.db'), 'settings')
    writeFileSync(synced, 'synced history')
    symlinkSync(synced, path.join(oldDir, 'history.db'))
    writeFileSync(path.join(oldDir, 'bin', 'yt-dlp'), 'yt-dlp binary')
    chmodSync(path.join(oldDir, 'bin', 'yt-dlp'), 0o755)
    writeFileSync(path.join(oldDir, 'Cache', 'index'), 'http cache')

    const result = migrateUserData({
      root,
      sources: ['FreeTube'],
      target: 'Fjernsyn',
      fs: nodeFileSystem,
      pid: process.pid,
      isAlive: () => true,
      now: () => Date.now(),
      sleep: () => {},
    })

    const newDir = path.join(root, 'Fjernsyn')
    expect(result.outcome).toBe('copied')
    expect(readFileSync(path.join(newDir, 'settings.db'), 'utf8')).toBe('settings')
    expect(readlinkSync(path.join(newDir, 'history.db'))).toBe(synced)
    expect(statSync(path.join(newDir, 'bin', 'yt-dlp')).mode & 0o777).toBe(0o755)
    expect(nodeFileSystem.kind(path.join(newDir, 'Cache'))).toBe(null)
    expect(nodeFileSystem.list(newDir).sort()).toEqual(['bin', 'history.db', 'settings.db'])
  })
})
