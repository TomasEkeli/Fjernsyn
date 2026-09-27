import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcChannels } from '../../constants'

// What the handlers are registered on, and what they call out to
const electron = vi.hoisted(() => ({
  listeners: new Map(),
  handlers: new Map(),
  appListeners: new Map(),
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/home/tomas/Downloads',
    on: (name, listener) => electron.appListeners.set(name, listener),
  },
  ipcMain: {
    on: (channel, listener) => electron.listeners.set(channel, listener),
    handle: (channel, handler) => electron.handlers.set(channel, handler),
  },
  net: { fetch: vi.fn() },
  shell: electron.shell,
}))

const stored = vi.hoisted(() => ({ settings: {} }))

vi.mock('../../datastores/handlers/base', () => ({
  settings: {
    _findOne: async id => (id in stored.settings ? { _id: id, value: stored.settings[id] } : null),
  },
}))

const sent = vi.hoisted(() => [])

vi.mock('../ytdlp/ipc', () => ({
  sendToAllFreeTube: (preferred, channel, payload) => sent.push({ preferred, channel, payload }),
}))

const { registerPeerTubeDownloadHandlers } = await import('./ipc')

const UUID = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
const KEY = `peertube:tilvids.com:${UUID}`
const FILE_URL = `https://tilvids.com/download/web-videos/${UUID}-1080.mp4`

// What isFreeTubeUrl takes for FreeTube's own page outside development
const FREETUBE_URL = 'app://bundle/index.html'

/** @type {{ name: string, args: unknown[] }[]} */
let calls
let quitParts

function fakeService() {
  const record = (name, result) => (...args) => {
    calls.push({ name, args })
    return result
  }

  return {
    start: async (request, report) => {
      calls.push({ name: 'start', args: [request] })
      report({ type: 'progress', videoId: request.key, title: request.title, download: {} })
    },
    cancel: record('cancel', true),
    dismiss: record('dismiss'),
    list: record('list', { downloads: [], finished: {} }),
    revealPath: async (key) => {
      calls.push({ name: 'revealPath', args: [key] })
      return { file: '/home/tomas/Downloads/A video [1080p].mp4' }
    },
    quit: () => {
      calls.push({ name: 'quit', args: [] })
      return quitParts
    },
    isBusy: () => false,
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {boolean} [options.focused]
 */
function event({ url = FREETUBE_URL, focused = true } = {}) {
  return { senderFrame: { url }, sender: { isFocused: () => focused } }
}

/**
 * @param {string} channel
 * @param {...unknown} args
 */
async function send(channel, ...args) {
  await electron.listeners.get(channel)(...args)
  // Let a started download report
  await new Promise(resolve => setImmediate(resolve))
}

const names = () => calls.map(call => call.name)

beforeEach(() => {
  calls = []
  quitParts = []
  sent.length = 0
  stored.settings = { enablePeerTube: true }
  electron.listeners.clear()
  electron.handlers.clear()
  electron.appListeners.clear()
  electron.shell.showItemInFolder.mockClear()
  electron.shell.openPath.mockClear()
  registerPeerTubeDownloadHandlers({ userAgent: 'Fjernsyn/0.0.1', downloadService: fakeService() })
})

describe('starting a download', () => {
  const payload = { key: KEY, url: FILE_URL, title: 'A video', label: '1080p', resolution: 1080 }

  it('starts one asked for by a focused FreeTube window, with PeerTube on', async () => {
    const asking = event()
    await send(IpcChannels.PEERTUBE_DOWNLOAD, asking, payload)

    expect(names()).toEqual(['start'])
    expect(calls[0].args[0]).toMatchObject({ key: KEY, url: FILE_URL, title: 'A video', resolution: 1080 })
  })

  it('sends outcomes on the yt-dlp outcome channel, preferring the window that asked for the toast', async () => {
    const asking = event()
    await send(IpcChannels.PEERTUBE_DOWNLOAD, asking, payload)

    expect(sent).toEqual([{ preferred: asking.sender, channel: IpcChannels.YTDLP_DOWNLOAD_OUTCOME, payload: expect.objectContaining({ type: 'progress', videoId: KEY }) }])
  })

  it('refuses a sender that is not FreeTube', async () => {
    await send(IpcChannels.PEERTUBE_DOWNLOAD, event({ url: 'https://tilvids.com/' }), payload)
    expect(calls).toEqual([])
  })

  it('refuses a window that is not focused', async () => {
    await send(IpcChannels.PEERTUBE_DOWNLOAD, event({ focused: false }), payload)
    expect(calls).toEqual([])
  })

  it('refuses while PeerTube is switched off', async () => {
    stored.settings = {}
    await send(IpcChannels.PEERTUBE_DOWNLOAD, event(), payload)

    stored.settings = { enablePeerTube: false }
    await send(IpcChannels.PEERTUBE_DOWNLOAD, event(), payload)

    expect(calls).toEqual([])
  })

  it('refuses a request the validator refuses', async () => {
    await send(IpcChannels.PEERTUBE_DOWNLOAD, event(), { ...payload, key: 'dQw4w9WgXcQ' })
    await send(IpcChannels.PEERTUBE_DOWNLOAD, event(), { ...payload, url: `http://tilvids.com/download/web-videos/${UUID}-1080.mp4` })
    await send(IpcChannels.PEERTUBE_DOWNLOAD, event(), null)

    expect(calls).toEqual([])
  })
})

describe('cancel, dismiss and reveal', () => {
  it('pass a valid key from FreeTube on', async () => {
    await send(IpcChannels.PEERTUBE_CANCEL, event(), KEY)
    await send(IpcChannels.PEERTUBE_DISMISS, event(), KEY)
    await send(IpcChannels.PEERTUBE_REVEAL, event(), KEY)

    expect(calls).toEqual([
      { name: 'cancel', args: [KEY] },
      { name: 'dismiss', args: [KEY] },
      { name: 'revealPath', args: [KEY] },
    ])
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith('/home/tomas/Downloads/A video [1080p].mp4')
  })

  it('ignore a peertube: key that does not match the pattern, and a YouTube id', async () => {
    for (const key of ['peertube:tilvids.com:not-a-uuid', `peertube:tilvids.com:${UUID}:../x`, 'peertube:', 'dQw4w9WgXcQ', 42]) {
      await send(IpcChannels.PEERTUBE_CANCEL, event(), key)
      await send(IpcChannels.PEERTUBE_DISMISS, event(), key)
      await send(IpcChannels.PEERTUBE_REVEAL, event(), key)
    }

    expect(calls).toEqual([])
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('ignore a sender that is not FreeTube', async () => {
    const stranger = event({ url: 'https://tilvids.com/' })
    await send(IpcChannels.PEERTUBE_CANCEL, stranger, KEY)
    await send(IpcChannels.PEERTUBE_DISMISS, stranger, KEY)
    await send(IpcChannels.PEERTUBE_REVEAL, stranger, KEY)

    expect(calls).toEqual([])
  })

  it('cancel only from a focused window', async () => {
    await send(IpcChannels.PEERTUBE_CANCEL, event({ focused: false }), KEY)
    expect(calls).toEqual([])
  })
})

describe('listing', () => {
  it('answers FreeTube only', async () => {
    const handler = electron.handlers.get(IpcChannels.PEERTUBE_LIST_DOWNLOADS)

    expect(await handler(event())).toEqual({ downloads: [], finished: {} })
    expect(await handler(event({ url: 'https://tilvids.com/' }))).toBeUndefined()
  })
})

describe('quitting', () => {
  it('stops the downloads, and removes the partial files it is given', async () => {
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'fjernsyn-peertube-'))
    const part = join(dir, 'A video [1080p].mp4.part')
    writeFileSync(part, 'partial')
    quitParts = [part, join(dir, 'gone already.part')]

    try {
      electron.appListeners.get('will-quit')()

      expect(names()).toEqual(['quit'])
      expect(existsSync(part)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
