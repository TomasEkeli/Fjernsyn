import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcChannels } from '../../constants'

// The backup's IPC handlers, with Electron, the datastores and the sender
// check stood in for: in-memory datastores, a temporary data folder

const electron = vi.hoisted(() => ({
  dataFolder: '',
  handlers: new Map(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => electron.dataFolder },
  ipcMain: { handle: (channel, handler) => electron.handlers.set(channel, handler) },
}))

vi.mock('../../datastores/index', async () => {
  const { default: Datastore } = await import('@seald-io/nedb')
  const names = ['settings', 'profiles', 'playlists', 'history', 'searchHistory', 'subscriptionCache', 'channels', 'aiVerdicts', 'later']
  return Object.fromEntries(names.map(name => [name, new Datastore({ inMemoryOnly: true })]))
})

vi.mock('../utils', () => ({
  isFreeTubeUrl: url => url.startsWith('app://bundle/'),
}))

const APP = { senderFrame: { url: 'app://bundle/index.html' } }
const ELSEWHERE = { senderFrame: { url: 'https://example.com/' } }

const MAIN_PROFILE = { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] }

let datastores

beforeEach(async () => {
  vi.resetModules()
  electron.handlers.clear()
  electron.dataFolder = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-backup-ipc-'))
  datastores = await import('../../datastores/index')
})

afterEach(() => {
  rmSync(electron.dataFolder, { recursive: true, force: true })
})

async function register() {
  const relaunch = vi.fn()
  const { registerBackupHandlers } = await import('./ipc')
  registerBackupHandlers({ relaunch })
  return {
    relaunch,
    folder: event => electron.handlers.get(IpcChannels.BACKUP_FOLDER)(event),
    restore: (event, request) => electron.handlers.get(IpcChannels.BACKUP_RESTORE)(event, request),
  }
}

describe('the backup handlers', () => {
  it('make an installation id when there is none', async () => {
    await register()
    await vi.waitFor(async () => {
      expect((await datastores.settings.findOneAsync({ _id: 'installationId' }))?.value).toMatch(/^[\da-f-]{36}$/)
    })
  })

  it('say where the safety copies go, to the app only', async () => {
    const { folder } = await register()

    expect(folder(APP)).toBe(path.join(electron.dataFolder, 'backups'))
    expect(folder(ELSEWHERE)).toBeNull()
  })

  it('restore for the app only', async () => {
    const { restore, relaunch } = await register()

    expect(await restore(ELSEWHERE, { safetyCopy: '{}', sections: { profiles: [] } })).toBeNull()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('restore and relaunch, then refuse another restore until the app is gone', async () => {
    const { restore, relaunch } = await register()

    const first = await restore(APP, { safetyCopy: '{}', sections: { profiles: [MAIN_PROFILE] } })
    const second = await restore(APP, { safetyCopy: '{}', sections: { profiles: [] } })

    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, error: 'A restore is already running', safetyCopyPath: null })
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(await datastores.profiles.findAsync({})).toEqual([MAIN_PROFILE])
  })

  it('take another restore after one failed', async () => {
    const { restore, relaunch } = await register()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const failed = await restore(APP, { safetyCopy: '', sections: {} })
    const next = await restore(APP, { safetyCopy: '{}', sections: { profiles: [MAIN_PROFILE] } })

    expect(failed.ok).toBe(false)
    expect(next.ok).toBe(true)
    expect(relaunch).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})
