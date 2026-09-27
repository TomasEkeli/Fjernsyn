/**
 * A fake `fetch` for the PeerTube download service, answering each URL with
 * a scripted response whose body streams the given chunks. A body can stop
 * part way and hang, like a stalled connection, until the request is
 * aborted, which is what cancelling and the stall watchdog do.
 *
 * @typedef {object} ScriptedResponse
 * @property {number} [status] 200 when not given
 * @property {string} [statusText]
 * @property {Record<string, string>} [headers]
 * @property {Uint8Array[]} [chunks]
 * @property {boolean} [hang] after the chunks, wait for an abort rather than end
 * @property {(chunk: Uint8Array, index: number) => void} [onChunk] called as each chunk is handed over
 *
 * A redirect is scripted as a 3xx status with a `location` header; like
 * `fetch` with `redirect: 'manual'` in Electron, it is handed back as it is.
 */

/**
 * @param {Record<string, ScriptedResponse>} responses by URL
 */
export function createFakeFetch(responses) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const requests = []

  /**
   * @param {string} url
   * @param {RequestInit} [init]
   */
  async function fetch(url, init = {}) {
    requests.push({ url, init })
    const signal = init.signal

    if (signal?.aborted) {
      throw signal.reason
    }

    const scripted = responses[url]
    if (!scripted) {
      return makeResponse(url, { status: 404, statusText: 'Not Found' }, signal)
    }

    return makeResponse(url, scripted, signal)
  }

  return { fetch, requests }
}

/**
 * @param {string} url
 * @param {ScriptedResponse} scripted
 * @param {AbortSignal | undefined | null} signal
 */
function makeResponse(url, scripted, signal) {
  const status = scripted.status ?? 200
  const chunks = scripted.chunks ?? []

  const body = (async function * () {
    for (let index = 0; index < chunks.length; index++) {
      if (signal?.aborted) {
        throw signal.reason
      }
      scripted.onChunk?.(chunks[index], index)
      yield chunks[index]
    }

    if (scripted.hang) {
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
  })()

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: scripted.statusText ?? '',
    url,
    headers: new Headers(scripted.headers ?? {}),
    body,
  }
}

/**
 * @param {number} size
 * @param {number} [fill]
 */
export function bytes(size, fill = 1) {
  return new Uint8Array(size).fill(fill)
}
