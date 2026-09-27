/**
 * The `fetch` the PeerTube download service is given in main: as much of
 * `fetch` as the service uses, built on Electron's `net.request`, which
 * hands a redirect back as it is instead of following it.
 *
 * The service follows redirects itself, so that every hop is held to the
 * URL rule in `request.js`. That needs a redirect answered as a 3xx with a
 * `location`, which is what `fetch` with `redirect: 'manual'` gives in a
 * browser. Electron's `net.fetch` does not. It rests on `ClientRequest`,
 * whose docs (https://www.electronjs.org/docs/latest/api/client-request) say
 * of the `redirect` option: "When mode is `manual` the redirection will be
 * cancelled unless `request.followRedirect` is invoked synchronously during
 * the `redirect` event". `net.fetch` never invokes it, so every download
 * behind a redirect failed at once with "Redirect was cancelled". That is
 * the normal case: an instance on object storage answers its download URL
 * with a 302 to a presigned URL on the storage's host.
 *
 * So the request is made here, the `'redirect'` event is turned into a 3xx
 * answer, and the redirect is left to be cancelled, as the service wants.
 * The request goes on the default session, the one `net.fetch` uses, so
 * FreeTube's proxy setting still applies.
 */

/**
 * The parts of a `Response` the download service reads, and nothing more.
 *
 * @typedef {object} NetResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {string} statusText
 * @property {string} url the URL asked for, not where a redirect points
 * @property {Headers} headers
 * @property {import('electron').IncomingMessage & import('node:stream').Readable | null} body
 *   Electron's `IncomingMessage`, a Node `Readable`, so async-iterable; null for a redirect
 */

/**
 * @typedef {object} NetFetchInit
 * @property {string} [method] GET when not given
 * @property {Record<string, string>} [headers] a plain object, as the service sends
 * @property {'omit' | 'include' | 'same-origin'} [credentials]
 * @property {'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached'} [cache]
 * @property {AbortSignal | null} [signal]
 * @property {string} [redirect] ignored: always `manual`, since following is the service's to do
 */

/**
 * @param {Pick<import('electron').Net, 'request'>} net Electron's `net`, injected so that tests can pass a fake
 * @returns {(url: string, init?: NetFetchInit) => Promise<NetResponse>}
 */
export function createNetFetch(net) {
  return function fetch(url, init = {}) {
    const { signal } = init

    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }

    return new Promise((resolve, reject) => {
      let settled = false

      /** @param {NetResponse} response */
      const answer = (response) => {
        if (!settled) {
          settled = true
          resolve(response)
        }
      }

      /** @param {unknown} error */
      const refuse = (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      }

      const request = net.request(withoutUndefined({
        url,
        method: init.method ?? 'GET',
        redirect: 'manual',
        credentials: init.credentials,
        cache: init.cache,
      }))

      // Once the request is over, so that a long download does not leave a
      // listener behind on the signal, nor a redirect one per hop
      const letGoOfSignal = () => signal?.removeEventListener('abort', onAbort)

      // Aborts even after the response has been handed back, so that the
      // connection goes: the body is then destroyed by Electron, and the
      // service does not wait on it, since it races every read against the
      // signal
      function onAbort() {
        request.abort()
        letGoOfSignal()
        refuse(signal?.reason)
      }

      // Listened for as long as the request lives, not only until it
      // settles: an `'error'` with no listener is thrown, and one always
      // follows a redirect handed back ("Redirect was cancelled"). Once
      // settled there is nobody left to tell.
      request.on('error', (error) => {
        letGoOfSignal()
        refuse(error)
      })

      request.on('close', letGoOfSignal)

      // Not followed: without `followRedirect` during the event, Electron
      // cancels the redirect, which is what is wanted here
      request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
        const headers = toHeaders(responseHeaders)
        // Absolute, as Electron resolves it, where the server's may be relative
        headers.set('location', redirectUrl)

        letGoOfSignal()
        answer({ ok: false, status: statusCode, statusText: '', url, headers, body: null })
      })

      request.on('response', (message) => {
        // Errors reach whoever is reading the body all the same; this is so
        // that one arriving while nobody is (the service never reads the
        // body of an error answer) is not thrown in main
        message.on('error', () => {})

        // A body given up before its end, as the service does when a
        // download fails part way, lets go of the connection with it.
        // Destroying the message alone only stops reading from it.
        message.once('close', () => {
          if (!message.readableEnded) {
            request.abort()
          }
        })

        const status = message.statusCode
        answer({
          ok: status >= 200 && status <= 299,
          status,
          statusText: message.statusMessage ?? '',
          url,
          headers: toHeaders(message.headers),
          body: /** @type {NetResponse['body']} */ (message),
        })
      })

      try {
        for (const [name, value] of Object.entries(init.headers ?? {})) {
          request.setHeader(name, value)
        }
      } catch (error) {
        request.abort()
        throw error
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      request.end()
    })
  }
}

/**
 * Electron's headers, a record of a value or an array of them, as `Headers`.
 * A value `Headers` refuses is left out rather than thrown, since it would
 * be thrown from inside an Electron event, uncaught.
 *
 * @param {Record<string, string | string[]> | undefined} record
 * @returns {Headers}
 */
function toHeaders(record) {
  const headers = new Headers()

  for (const [name, value] of Object.entries(record ?? {})) {
    for (const each of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, each)
      } catch {}
    }
  }

  return headers
}

/**
 * `net.request` is given only the options that were set.
 *
 * @template {Record<string, unknown>} T
 * @param {T} options
 * @returns {T}
 */
function withoutUndefined(options) {
  return /** @type {T} */ (Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)))
}
