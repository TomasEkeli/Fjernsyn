import { EventEmitter, getEventListeners } from 'node:events'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { createPeerTubeDownloadService } from './downloadService'
import { createNetFetch } from './netFetch'
import { createMemoryFileSystem } from '../ytdlp/testing/memoryFileSystem'

const UUID = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
const FILE_URL = `https://video.blender.org/download/web-videos/${UUID}-1080.mp4`
const STORAGE_URL = `https://objectstorage.example.net/videos/web-videos/${UUID}-1080.mp4?X-Amz-Signature=abc`
const USER_AGENT = 'Fjernsyn/0.0.1 (+https://github.com/TomasEkeli/Fjernsyn)'
const DOWNLOADS = '/home/tomas/Downloads'

/**
 * @typedef {EventEmitter & {
 *   options: Record<string, unknown>,
 *   setHeader: import('vitest').Mock,
 *   end: import('vitest').Mock,
 *   abort: import('vitest').Mock,
 *   followRedirect: import('vitest').Mock,
 *   response: Readable | null,
 *   closed: boolean,
 * }} FakeRequest
 */

/**
 * A fake of Electron's `net`, as far as `net.request` goes. The request
 * behaves as Electron's `ClientRequest` does where it matters here: a
 * redirect not followed during the `'redirect'` event is cancelled with an
 * `'error'`, an abort destroys any response and closes the request, and
 * `'close'` is the last thing it emits.
 *
 * @param {(request: FakeRequest) => void} [answer] what the server does once the request is sent
 */
function createFakeNet(answer = () => {}) {
  /** @type {FakeRequest[]} */
  const requests = []

  const net = {
    request: vi.fn((options) => {
      const request = /** @type {FakeRequest} */ (new EventEmitter())
      request.options = options
      request.response = null
      request.closed = false
      request.setHeader = vi.fn()
      request.followRedirect = vi.fn()
      request.abort = vi.fn(() => {
        if (request.closed) {
          return
        }
        request.emit('abort')
        request.response?.destroy()
        close(request)
      })
      request.end = vi.fn(() => {
        setImmediate(() => answer(request))
      })
      requests.push(request)
      return request
    }),
  }

  return { net, requests }
}

/**
 * @param {FakeRequest} request
 */
function close(request) {
  if (!request.closed) {
    request.closed = true
    request.emit('close')
  }
}

/**
 * Answers with a redirect, which Electron cancels unless it was followed
 * during the event.
 *
 * @param {FakeRequest} request
 * @param {number} statusCode
 * @param {string} redirectUrl absolute, as Electron gives it
 * @param {Record<string, string[]>} [responseHeaders]
 */
function redirect(request, statusCode, redirectUrl, responseHeaders = { location: [redirectUrl] }) {
  request.emit('redirect', statusCode, 'GET', redirectUrl, responseHeaders)

  if (request.followRedirect.mock.calls.length === 0 && !request.closed) {
    process.nextTick(() => {
      request.emit('error', new Error('Redirect was cancelled'))
      close(request)
    })
  }
}

/**
 * Answers with a response whose body streams the chunks, then ends, or
 * hangs as a stalled connection does.
 *
 * @param {FakeRequest} request
 * @param {object} response
 * @param {number} [response.statusCode]
 * @param {string | null} [response.statusMessage]
 * @param {Record<string, string | string[]>} [response.headers]
 * @param {Buffer[]} [response.chunks]
 * @param {boolean} [response.hang]
 */
function respond(request, { statusCode = 200, statusMessage = 'OK', headers = {}, chunks = [], hang = false }) {
  let message
  if (hang) {
    message = new Readable({ read() {} })
    for (const chunk of chunks) {
      message.push(chunk)
    }
  } else {
    message = Readable.from(chunks)
  }

  Object.assign(message, { statusCode, statusMessage, headers })
  message.on('end', () => close(request))
  request.response = message
  request.emit('response', message)
}

/**
 * @param {FakeRequest} request
 * @param {Error} error
 */
function fail(request, error) {
  request.emit('error', error)
  close(request)
}

/**
 * @param {AsyncIterable<Uint8Array>} body
 */
async function readAll(body) {
  const chunks = []
  for await (const chunk of body) {
    chunks.push(...chunk)
  }
  return chunks
}

/**
 * @param {() => boolean} predicate
 */
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(predicate()).toBe(true)
}

const DOWNLOAD_INIT = {
  method: 'GET',
  headers: { 'User-Agent': USER_AGENT },
  redirect: 'manual',
  credentials: 'omit',
  cache: 'no-store',
}

describe('the request', () => {
  it('asks for a manual redirect, no credentials and no cache, with the User-Agent', async () => {
    const { net, requests } = createFakeNet(request => respond(request, {}))
    const fetch = createNetFetch(net)

    await fetch(FILE_URL, DOWNLOAD_INIT)

    expect(net.request).toHaveBeenCalledTimes(1)
    expect(requests[0].options).toEqual({
      url: FILE_URL,
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    })
    expect(requests[0].setHeader).toHaveBeenCalledWith('User-Agent', USER_AGENT)
    expect(requests[0].end).toHaveBeenCalledTimes(1)
  })

  it('is a GET when no method is given, and leaves out the options it was not given', async () => {
    const { net, requests } = createFakeNet(request => respond(request, {}))

    await createNetFetch(net)(FILE_URL)

    expect(requests[0].options).toEqual({ url: FILE_URL, method: 'GET', redirect: 'manual' })
    expect(requests[0].setHeader).not.toHaveBeenCalled()
  })

  it('is always a manual redirect, whatever it is asked for, so that main never follows one unchecked', async () => {
    const { net, requests } = createFakeNet(request => respond(request, {}))

    await createNetFetch(net)(FILE_URL, { redirect: 'follow' })

    expect(requests[0].options.redirect).toBe('manual')
  })
})

describe('a redirect', () => {
  it('is handed back as a 3xx with an absolute location, never followed', async () => {
    const { net, requests } = createFakeNet(request => redirect(request, 302, STORAGE_URL, {
      location: ['/videos/relative-as-the-server-sent-it.mp4'],
      'x-amz-request-id': ['one', 'two'],
    }))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)

    expect(response).toMatchObject({ ok: false, status: 302, statusText: '', url: FILE_URL, body: null })
    expect(response.headers.get('location')).toBe(STORAGE_URL)
    expect(response.headers.get('x-amz-request-id')).toBe('one, two')
    expect(requests[0].followRedirect).not.toHaveBeenCalled()
  })

  it('swallows the "Redirect was cancelled" error that follows', async () => {
    const { net, requests } = createFakeNet(request => redirect(request, 301, STORAGE_URL))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)
    await until(() => requests[0].closed)

    expect(response.status).toBe(301)
    // Still listened for, so that another one cannot throw either
    expect(requests[0].listenerCount('error')).toBeGreaterThan(0)
    expect(() => requests[0].emit('error', new Error('Redirect was cancelled'))).not.toThrow()
  })
})

describe('a response', () => {
  it('streams its body as it arrives', async () => {
    const { net } = createFakeNet(request => respond(request, {
      chunks: [Buffer.from([1, 2]), Buffer.from([3]), Buffer.from([4, 5, 6])],
    }))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)

    expect(response).toMatchObject({ ok: true, status: 200, statusText: 'OK', url: FILE_URL })
    expect(await readAll(response.body)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('carries its headers, those given more than once included', async () => {
    const { net } = createFakeNet(request => respond(request, {
      headers: {
        'content-length': '6',
        'content-type': 'video/mp4',
        'x-cache': ['MISS', 'HIT'],
      },
    }))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)

    expect(response.headers.get('content-length')).toBe('6')
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(response.headers.get('x-cache')).toBe('MISS, HIT')
    expect(response.headers.get('content-encoding')).toBeNull()
  })

  it('is not ok outside 200 to 299, and keeps the status text', async () => {
    const { net } = createFakeNet(request => respond(request, { statusCode: 404, statusMessage: 'Not Found' }))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)

    expect(response).toMatchObject({ ok: false, status: 404, statusText: 'Not Found' })
  })

  it('has an empty status text when the server sent none', async () => {
    // As over HTTP/2, which has no reason phrase
    const { net } = createFakeNet(request => respond(request, { statusMessage: null }))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)

    expect(response.statusText).toBe('')
  })

  it('does not throw when its body fails while nobody is reading it', async () => {
    const { net } = createFakeNet(request => respond(request, { hang: true }))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)
    response.body.destroy(new Error('net::ERR_CONNECTION_RESET'))

    // An 'error' with no listener would be thrown from here, uncaught
    await new Promise(resolve => setImmediate(resolve))
    expect(response.body.destroyed).toBe(true)
  })

  it('lets go of the connection when its body is given up before the end', async () => {
    const { net, requests } = createFakeNet(request => respond(request, {
      chunks: [Buffer.from([1]), Buffer.from([2])],
      hang: true,
    }))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)
    const iterator = response.body[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return()

    await until(() => requests[0].abort.mock.calls.length > 0)
  })

  it('leaves the connection alone once its body has been read to the end', async () => {
    const { net, requests } = createFakeNet(request => respond(request, { chunks: [Buffer.from([1])] }))

    const response = await createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)
    await readAll(response.body)
    await new Promise(resolve => setImmediate(resolve))

    expect(requests[0].abort).not.toHaveBeenCalled()
  })
})

describe('an error', () => {
  it('before any answer rejects with it', async () => {
    const error = new Error('net::ERR_NAME_NOT_RESOLVED')
    const { net } = createFakeNet(request => fail(request, error))

    await expect(createNetFetch(net)(FILE_URL, DOWNLOAD_INIT)).rejects.toBe(error)
  })

  it('that net.request throws rejects with it', async () => {
    const error = new TypeError('Invalid URL')
    const net = { request: () => { throw error } }

    await expect(createNetFetch(net)('nonsense', DOWNLOAD_INIT)).rejects.toBe(error)
  })
})

describe('aborting', () => {
  it('rejects at once with the reason when already aborted, making no request', async () => {
    const { net } = createFakeNet(request => respond(request, {}))
    const controller = new AbortController()
    const reason = new Error('Cancelled')
    controller.abort(reason)

    await expect(createNetFetch(net)(FILE_URL, { ...DOWNLOAD_INIT, signal: controller.signal })).rejects.toBe(reason)
    expect(net.request).not.toHaveBeenCalled()
  })

  it('before the answer aborts the request and rejects with the reason', async () => {
    const { net, requests } = createFakeNet()
    const controller = new AbortController()
    const reason = new Error('No data from video.blender.org for 30 seconds')

    const fetched = createNetFetch(net)(FILE_URL, { ...DOWNLOAD_INIT, signal: controller.signal })
    await until(() => requests.length === 1)
    controller.abort(reason)

    await expect(fetched).rejects.toBe(reason)
    expect(requests[0].abort).toHaveBeenCalled()
  })

  it('after the response aborts the request, so that the connection goes', async () => {
    const { net, requests } = createFakeNet(request => respond(request, { chunks: [Buffer.from([1])], hang: true }))
    const controller = new AbortController()

    const response = await createNetFetch(net)(FILE_URL, { ...DOWNLOAD_INIT, signal: controller.signal })
    controller.abort(new Error('Cancelled'))

    expect(requests[0].abort).toHaveBeenCalled()
    expect(response.body.destroyed).toBe(true)
  })

  it('is no longer listened for once the request is over', async () => {
    const { net, requests } = createFakeNet(request => respond(request, { chunks: [Buffer.from([1])] }))
    const controller = new AbortController()

    const response = await createNetFetch(net)(FILE_URL, { ...DOWNLOAD_INIT, signal: controller.signal })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)

    await readAll(response.body)
    await until(() => requests[0].closed)

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('is no longer listened for once a redirect has been handed back', async () => {
    const { net, requests } = createFakeNet(request => redirect(request, 302, STORAGE_URL))
    const controller = new AbortController()

    await createNetFetch(net)(FILE_URL, { ...DOWNLOAD_INIT, signal: controller.signal })
    await until(() => requests[0].closed)

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})

describe('under the download service', () => {
  it('downloads through a 302 to object storage', async () => {
    const file = [Buffer.from([1, 2, 3]), Buffer.from([4, 5])]
    const { net, requests } = createFakeNet((request) => {
      if (request.options.url === FILE_URL) {
        redirect(request, 302, STORAGE_URL)
      } else if (request.options.url === STORAGE_URL) {
        respond(request, { headers: { 'content-type': 'video/mp4', 'content-length': '5' }, chunks: file })
      } else {
        respond(request, { statusCode: 404, statusMessage: 'Not Found' })
      }
    })

    const fileSystem = createMemoryFileSystem()
    const service = createPeerTubeDownloadService({
      fetch: createNetFetch(net),
      fileSystem,
      readSetting: async () => '',
      defaultDownloadFolder: () => DOWNLOADS,
      userAgent: USER_AGENT,
      platform: 'linux',
    })

    const outcomes = []
    await service.start({
      key: `peertube:video.blender.org:${UUID}`,
      url: FILE_URL,
      title: 'Sprite Fright',
      label: '1080p',
      resolution: 1080,
      audioOnly: false,
      videoUrl: null,
    }, outcome => outcomes.push(outcome))

    expect(outcomes.at(-1)).toMatchObject({ type: 'finished', path: `${DOWNLOADS}/Sprite Fright [1080p].mp4` })
    expect([...fileSystem.files.get(`${DOWNLOADS}/Sprite Fright [1080p].mp4`).data]).toEqual([1, 2, 3, 4, 5])
    expect(requests.map(request => request.options.url)).toEqual([FILE_URL, STORAGE_URL])
    expect(requests.every(request => request.followRedirect.mock.calls.length === 0)).toBe(true)
    expect(requests[1].setHeader).toHaveBeenCalledWith('User-Agent', USER_AGENT)
  })
})
