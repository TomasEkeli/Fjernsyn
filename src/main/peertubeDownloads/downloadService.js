import path from 'node:path'

import { buildFileName, chooseExtension, numberedName } from './fileName'
import { checkFileUrl } from './request'

export { buildFileName } from './fileName'

/**
 * The PeerTube download service: fetches a file an instance offers for
 * download, as a plain HTTP GET, into the download folder, and reports how it
 * is getting on in the shapes the yt-dlp download service uses, so that the
 * downloads panel, the toasts and the renderer's store take it unchanged.
 * Never yt-dlp.
 *
 * The file is written under `<final name>.part`, opened exclusively, and
 * linked to its final name once complete, never replacing a file. A
 * download that fails, is cancelled or is stopped on quit has its `.part`
 * removed: there is no resuming in phase 1, so pressing download again
 * starts over.
 *
 * Everything it touches outside itself is injected, so that it can be driven
 * in tests with a scripted fetch and an in-memory file system.
 */

/**
 * @typedef {import('../ytdlp/downloadService').DownloadSnapshot} DownloadSnapshot
 *   with `videoId` the download key and `quality` the label
 */

/**
 * @typedef {(
 *   { type: 'progress', videoId: string, title: string, download: DownloadSnapshot } |
 *   { type: 'started', videoId: string, title: string, download: DownloadSnapshot } |
 *   { type: 'already-running', videoId: string, title: string } |
 *   { type: 'finished', videoId: string, title: string, path: string, download: DownloadSnapshot } |
 *   { type: 'failed', videoId: string, title: string, reason: string, exitCode: null, download: DownloadSnapshot } |
 *   { type: 'cancelled', videoId: string, title: string, download: DownloadSnapshot }
 * )} PeerTubeDownloadOutcome
 */

// Progress goes to the renderer at most this often per download
const PROGRESS_INTERVAL_MS = 1000

// How much of each new speed sample is taken, against the running figure
const SPEED_SMOOTHING = 0.3

// A download that goes this long without a byte is given up on: fetch
// itself would wait forever on a network that swallows connections
const STALL_MS = 30_000

// How long an ended download stays listed, for a window opened afterwards
const ENDED_KEPT_MS = 5 * 60 * 1000

// Beyond this many files of the same name, something is wrong
const MAX_NUMBERED = 999

// Tries at a name that something else keeps taking first
const MAX_ATTEMPTS = 10

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

// Where a hard link cannot be made: FAT and exFAT drives, some network shares
const NO_HARD_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'])

/**
 * A redirect's body is not wanted; not waited on.
 *
 * @param {Response} response
 */
function discardBody(response) {
  try {
    const body = /** @type {any} */ (response.body)
    // A web stream is cancelled; a Node stream (Electron's IncomingMessage,
    // from netFetch.js) is destroyed, which also lets go of its request
    const cancelled = body?.cancel?.() ?? body?.return?.() ?? body?.destroy?.()
    cancelled?.catch?.(() => {})
  } catch {}
}

/**
 * @param {number} status
 * @param {string} statusText
 */
function statusReason(status, statusText) {
  if (status === 429) {
    return 'The instance is limiting downloads (HTTP 429). Try again later'
  }

  return `The instance answered HTTP ${status}${statusText ? ` ${statusText}` : ''}`
}

/**
 * @param {object} deps
 * @param {(url: string, init: RequestInit) => Promise<Response>} deps.fetch `netFetch.js` in production, on Electron's `net`, which goes through the session's proxy and hands a redirect back as a 3xx
 * @param {import('../ytdlp/nodeFileSystem').FileSystem} deps.fileSystem
 * @param {(id: 'ytDlpDownloadFolder') => Promise<string>} deps.readSetting
 * @param {() => string} deps.defaultDownloadFolder the system Downloads folder
 * @param {string} deps.userAgent the prescribed `Fjernsyn/<version> (+https://github.com/TomasEkeli/Fjernsyn)`
 * @param {string} [deps.platform]
 * @param {() => number} [deps.now]
 * @param {number} [deps.stallMs]
 */
export function createPeerTubeDownloadService(deps) {
  const {
    fetch,
    fileSystem: fs,
    readSetting,
    defaultDownloadFolder,
    userAgent,
    platform = process.platform,
    now = Date.now,
    stallMs = STALL_MS,
  } = deps
  const pathModule = platform === 'win32' ? path.win32 : path.posix

  /**
   * The downloads under way, by key.
   * @type {Map<string, { controller: AbortController, why: 'cancel' | 'quit' | null, partPath: string | null }>}
   */
  const running = new Map()

  /**
   * Every download this session, running or recently ended.
   * @type {Map<string, DownloadSnapshot>}
   */
  const downloads = new Map()

  /**
   * The finished file per key, so that "show in folder" is asked for by key
   * and never by a path the renderer supplies.
   * @type {Map<string, { path: string, folder: string }>}
   */
  const finished = new Map()

  /** Final paths taken by downloads under way, so that two never share one */
  const claimed = new Set()

  let stopping = false

  /**
   * Resolves once the download has ended, however it ended.
   *
   * @param {import('./request').PeerTubeDownloadRequest} request validated
   * @param {(outcome: PeerTubeDownloadOutcome) => void} report
   */
  async function start(request, report) {
    const { key, title } = request

    if (running.has(key)) {
      report({ type: 'already-running', videoId: key, title })
      return
    }

    if (stopping) {
      return
    }

    const job = { controller: new AbortController(), why: null, partPath: null }
    running.set(key, job)

    try {
      await run(request, job, report)
    } finally {
      running.delete(key)
    }
  }

  /**
   * @param {import('./request').PeerTubeDownloadRequest} request
   * @param {{ controller: AbortController, why: 'cancel' | 'quit' | null, partPath: string | null }} job
   * @param {(outcome: PeerTubeDownloadOutcome) => void} report
   */
  async function run({ key, url, title, label, resolution, audioOnly }, job, report) {
    const { signal } = job.controller

    /** @type {DownloadSnapshot} */
    const download = {
      videoId: key,
      title,
      quality: /** @type {any} */ (label),
      height: !audioOnly && resolution ? resolution : null,
      audioOnly,
      status: 'preparing',
      folder: '',
      destination: null,
      resuming: false,
      part: 1,
      parts: 1,
      partKind: audioOnly ? 'audio' : 'both',
      downloadedBytes: null,
      totalBytes: null,
      speed: null,
      eta: null,
      reason: null,
      exitCode: null,
      endedAt: null,
    }
    downloads.set(key, download)

    const snapshot = () => ({ ...download })

    // Settles only by rejecting, when the download is cancelled, stopped or
    // stalls, so that whatever is being waited on is given up at once, even
    // a body that does not heed the signal
    const aborted = new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    aborted.catch(() => {})

    /** @template T @param {Promise<T>} promise @returns {Promise<T>} */
    const orAbort = promise => Promise.race([promise, aborted])

    let stallTimer
    const alive = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        job.controller.abort(new Error(`No data from ${URL.parse(url)?.hostname ?? 'the instance'} for ${Math.round(stallMs / 1000)} seconds`))
      }, stallMs)
    }

    /** @type {Awaited<ReturnType<typeof fs.openWrite>> | null} */
    let file = null
    /** @type {string | null} */
    let finalPath = null

    try {
      download.folder = (await orAbort(readSetting('ytDlpDownloadFolder'))) || defaultDownloadFolder()
      report({ type: 'progress', videoId: key, title, download: snapshot() })

      alive()
      const { response, finalUrl } = await fetchFollowingRedirects(url, signal, orAbort)

      if (!response.ok) {
        discardBody(response)
        throw new Error(statusReason(response.status, response.statusText))
      }

      if (!response.body) {
        throw new Error('The instance sent no file')
      }

      // A compressed body's length is not the file's: no percent, and no
      // telling a short file from a well compressed one
      const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase()
      const length = Number(response.headers.get('content-length'))
      const total = (encoding === '' || encoding === 'identity') && Number.isFinite(length) && length > 0 ? length : null

      const name = buildFileName({
        title,
        fallback: key.split(':')[2],
        tag: audioOnly ? 'audio' : resolution ? `${resolution}p` : label || null,
        extension: chooseExtension({ contentType: response.headers.get('content-type'), url: finalUrl, audioOnly }),
      })

      await orAbort(fs.mkdir(download.folder))

      // The `.part` is opened exclusively: one that turns up beside the name
      // after it was checked, from another program or an earlier session,
      // is left alone, and the next free name is taken instead
      for (let attempt = 1; file === null; attempt++) {
        finalPath = await orAbort(claimName(download.folder, name))
        try {
          file = await orAbort(fs.openWrite(`${finalPath}.part`, { exclusive: true }))
          job.partPath = `${finalPath}.part`
        } catch (error) {
          claimed.delete(finalPath)
          finalPath = null
          if (error?.code !== 'EEXIST' || attempt >= MAX_ATTEMPTS) {
            throw error
          }
        }
      }

      download.status = 'downloading'
      download.destination = finalPath
      download.totalBytes = total
      download.downloadedBytes = 0
      report({ type: 'started', videoId: key, title, download: snapshot() })

      let lastSent = now()
      let bytesAtLastSend = 0

      const iterator = response.body[Symbol.asyncIterator]()
      try {
        while (true) {
          const { value, done } = await orAbort(iterator.next())
          if (done) {
            break
          }

          alive()
          await orAbort(file.write(value))
          download.downloadedBytes += value.length

          if (total !== null && download.downloadedBytes > total) {
            throw new Error(`The instance sent more than the ${total} bytes it announced`)
          }

          const time = now()
          if (time - lastSent >= PROGRESS_INTERVAL_MS) {
            const sample = (download.downloadedBytes - bytesAtLastSend) / ((time - lastSent) / 1000)
            download.speed = download.speed === null ? sample : SPEED_SMOOTHING * sample + (1 - SPEED_SMOOTHING) * download.speed
            download.eta = total !== null && download.speed > 0 ? Math.max(0, total - download.downloadedBytes) / download.speed : null
            lastSent = time
            bytesAtLastSend = download.downloadedBytes
            report({ type: 'progress', videoId: key, title, download: snapshot() })
          }
        }
      } catch (error) {
        // Lets go of the connection when it ended early; not waited on, since
        // a stream with a read still pending may not answer
        Promise.resolve().then(() => iterator.return?.()).catch(() => {})
        throw error
      }

      clearTimeout(stallTimer)
      await file.close()
      file = null

      if (total !== null && download.downloadedBytes < total) {
        throw new Error(`The download ended early, after ${download.downloadedBytes} of ${total} bytes`)
      }

      finalPath = await finalise(job.partPath, download.folder, name, finalPath)
      job.partPath = null
      download.destination = finalPath

      end(download, 'finished')
      finished.set(key, { path: finalPath, folder: download.folder })
      report({ type: 'finished', videoId: key, title, path: finalPath, download: snapshot() })
    } catch (error) {
      clearTimeout(stallTimer)

      if (file !== null) {
        try {
          await file.close()
        } catch {}
      }

      // Nothing half-written is left under any name
      if (job.partPath !== null) {
        try {
          await fs.rm(job.partPath)
        } catch {}
      }

      if (job.why === 'quit') {
        downloads.delete(key)
        return
      }

      if (job.why === 'cancel') {
        end(download, 'cancelled')
        report({ type: 'cancelled', videoId: key, title, download: snapshot() })
        return
      }

      const reason = String(error?.message ?? error)
      end(download, 'failed', reason)
      report({ type: 'failed', videoId: key, title, reason, exitCode: null, download: snapshot() })
    } finally {
      clearTimeout(stallTimer)
      if (finalPath !== null) {
        claimed.delete(finalPath)
      }
    }
  }

  /**
   * Fetches, following up to five redirects by hand so that every hop is
   * held to the same URL rule as the URL the renderer sent: a redirect to
   * anywhere else refuses the download.
   *
   * @param {string} url checked already
   * @param {AbortSignal} signal
   * @param {<T>(promise: Promise<T>) => Promise<T>} orAbort
   * @returns {Promise<{ response: Response, finalUrl: string }>}
   */
  async function fetchFollowingRedirects(url, signal, orAbort) {
    let current = url

    for (let hop = 0; ; hop++) {
      const response = await orAbort(fetch(current, {
        method: 'GET',
        headers: { 'User-Agent': userAgent },
        redirect: 'manual',
        // No session cookies to instances, and multi-gigabyte files kept out
        // of the HTTP cache
        credentials: 'omit',
        cache: 'no-store',
        signal,
      }))

      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, finalUrl: current }
      }

      discardBody(response)

      if (hop >= MAX_REDIRECTS) {
        throw new Error(`The instance redirected the download more than ${MAX_REDIRECTS} times`)
      }

      const location = response.headers.get('location')
      const next = location === null ? null : checkFileUrl(URL.parse(location, current)?.href)

      if (next === null) {
        throw new Error('The instance redirected the download somewhere Fjernsyn does not download from')
      }

      current = next
    }
  }

  /**
   * Puts the finished `.part` under its final name without ever replacing a
   * file: a hard link, which fails rather than replace, then the `.part`
   * removed. A file that has taken the name meanwhile moves the download on
   * to the next free name. On a file system without hard links, a rename
   * once the name is seen to be free.
   *
   * @param {string} partPath
   * @param {string} folder
   * @param {string} name
   * @param {string} finalPath claimed
   * @returns {Promise<string>} where it ended up, claimed
   */
  async function finalise(partPath, folder, name, finalPath) {
    let target = finalPath

    for (let attempt = 1; ; attempt++) {
      let code
      try {
        await fs.link(partPath, target)
        try {
          await fs.rm(partPath)
        } catch {}
        return target
      } catch (error) {
        code = error?.code
        if (code !== 'EEXIST' && !NO_HARD_LINK_CODES.has(code)) {
          throw error
        }
      }

      if (NO_HARD_LINK_CODES.has(code) && !await fs.exists(target)) {
        await fs.rename(partPath, target)
        return target
      }

      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`Could not find a free name for ${name} in ${folder}`)
      }

      // Taken since it was claimed, by something outside Fjernsyn
      const next = await claimName(folder, name)
      claimed.delete(target)
      target = next
    }
  }

  /**
   * The first of `name`, `name (2)` and so on that is not there, has no
   * `.part` beside it, and is not claimed by another download under way.
   * Claimed before looking, so that two downloads looking at once cannot
   * both take it.
   *
   * @param {string} folder
   * @param {string} name
   */
  async function claimName(folder, name) {
    for (let n = 1; n <= MAX_NUMBERED; n++) {
      const candidate = pathModule.join(folder, numberedName(name, n))
      if (claimed.has(candidate)) {
        continue
      }

      claimed.add(candidate)
      if (!await fs.exists(candidate) && !await fs.exists(`${candidate}.part`)) {
        return candidate
      }
      claimed.delete(candidate)
    }

    throw new Error(`Too many files named ${name} in ${folder}`)
  }

  /**
   * @param {DownloadSnapshot} download
   * @param {'finished' | 'failed' | 'cancelled'} status
   * @param {string | null} [reason]
   */
  function end(download, status, reason = null) {
    download.status = status
    download.reason = reason
    download.speed = null
    download.eta = null
    download.endedAt = now()
  }

  /**
   * Stops a download and removes its partial file. One still being prepared
   * never starts.
   *
   * @param {string} key
   * @returns {boolean} whether there was one to stop
   */
  function cancel(key) {
    const job = running.get(key)
    if (!job) {
      return false
    }

    job.why = 'cancel'
    job.controller.abort(new Error('Cancelled'))
    return true
  }

  /**
   * Stops every download, telling nobody. Their partial files are removed
   * as they stop; the paths are returned too, for the caller to remove at
   * once, since the app may be gone before that happens.
   *
   * @returns {string[]}
   */
  function quit() {
    stopping = true
    const parts = []

    for (const job of running.values()) {
      job.why = 'quit'
      job.controller.abort(new Error('Quitting'))
      if (job.partPath !== null) {
        parts.push(job.partPath)
      }
    }

    return parts
  }

  /**
   * The downloads this session that are running or ended recently, and the
   * finished file per key, in the shape the yt-dlp service lists them.
   */
  function list() {
    const cutoff = now() - ENDED_KEPT_MS

    for (const [key, download] of downloads) {
      if (download.endedAt !== null && download.endedAt < cutoff) {
        downloads.delete(key)
      }
    }

    return {
      downloads: [...downloads.values()].map(download => ({ ...download })),
      finished: Object.fromEntries([...finished].map(([key, { path: filePath }]) => [key, filePath])),
    }
  }

  /**
   * Takes an ended download off the list. Its finished file is still
   * remembered for "show in folder".
   *
   * @param {string} key
   */
  function dismiss(key) {
    if (downloads.get(key)?.endedAt != null) {
      downloads.delete(key)
    }
  }

  /**
   * What "show in folder" should show for a key: the finished file, or its
   * folder once it has been moved or deleted. Null when there is nothing
   * finished for it.
   *
   * @param {string} key
   * @returns {Promise<{ file: string } | { folder: string } | null>}
   */
  async function revealPath(key) {
    const done = finished.get(key)
    if (!done) {
      return null
    }

    return await fs.exists(done.path) ? { file: done.path } : { folder: done.folder }
  }

  function isBusy() {
    return running.size > 0
  }

  return { start, cancel, dismiss, list, revealPath, quit, isBusy }
}
