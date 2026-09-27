// A fake `fetch` for the PeerTube adapter's tests, answering from recorded
// fixtures (`../fixtures/*.json`, each `{ url, status, headers, body }`) and
// recording every request it is asked, with its headers, so that tests can
// assert on what went out (or that nothing did).
//
//   const fake = createFakeFetch([blenderConfig, blenderVideo])
//   fake.respond('https://tilvids.com/api/v1/config', tilvidsConfig)
//   fake.respond(/\/api\/v1\/videos\//, notFound)
//   fake.respond('https://down.example/api/v1/config', new TypeError('Failed to fetch'))
//   const layer = createPlatformLayer({ fetch: fake.fetch })
//   ...
//   expect(fake.requests).toHaveLength(1)
//
// A request nothing is registered for fails as a network failure does (a
// rejected `TypeError`), and is still recorded.

/**
 * @typedef {object} FakeResponse
 * @property {number} [status] defaults to 200
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body] an object or array is sent as JSON, a string as is
 */

/**
 * @typedef {object} RecordedRequest
 * @property {string} url
 * @property {string} method
 * @property {Record<string, string>} headers lower-cased names
 */

/**
 * @typedef {string | RegExp | ((url: string) => boolean)} UrlMatcher
 * A string matches the same URL with its query in any order.
 */

/**
 * @typedef {FakeResponse | Error | ((request: RecordedRequest) => FakeResponse | Error)} Answer
 * An Error rejects the fetch with it, as a network failure does.
 */

/**
 * @param {string} url
 * @returns {string}
 */
function normaliseUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.searchParams.sort()
    return parsed.href
  } catch {
    return url
  }
}

/**
 * @param {UrlMatcher} matcher
 * @param {string} url
 * @returns {boolean}
 */
function matches(matcher, url) {
  if (typeof matcher === 'string') {
    return normaliseUrl(matcher) === normaliseUrl(url)
  }

  if (matcher instanceof RegExp) {
    return matcher.test(url)
  }

  return matcher(url)
}

/**
 * @param {HeadersInit | undefined} headers
 * @returns {Record<string, string>}
 */
function plainHeaders(headers) {
  /** @type {Record<string, string>} */
  const plain = {}

  new Headers(headers).forEach((value, name) => {
    plain[name] = value
  })

  return plain
}

/**
 * @param {FakeResponse} answer
 * @returns {Response}
 */
function toResponse({ status = 200, headers = {}, body = null }) {
  const text = body === null || typeof body === 'string' ? body : JSON.stringify(body)

  // A null body status cannot carry a body
  return new Response([204, 304].includes(status) ? null : text, { status, headers })
}

/**
 * @param {Array<FakeResponse & { url: string }>} [fixtures] registered at their own `url`
 */
export function createFakeFetch(fixtures = []) {
  /** @type {Array<{ matcher: UrlMatcher, answer: Answer }>} */
  const routes = []

  /** @type {RecordedRequest[]} */
  const requests = []

  /**
   * Registers an answer for the URLs a matcher matches. The latest
   * registration wins, so a test can override a fixture.
   *
   * @param {UrlMatcher} matcher
   * @param {Answer} answer
   */
  function respond(matcher, answer) {
    routes.unshift({ matcher, answer })
    return fake
  }

  /**
   * @param {string | URL | Request} input
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const request = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: plainHeaders(init.headers),
    }

    requests.push(request)

    const route = routes.find(({ matcher }) => matches(matcher, url))

    if (!route) {
      throw new TypeError(`fake fetch: nothing registered for ${url}`)
    }

    const answer = typeof route.answer === 'function' ? route.answer(request) : route.answer

    if (answer instanceof Error) {
      throw answer
    }

    return toResponse(answer)
  }

  const fake = {
    fetch,
    respond,
    /** Every request made, in order */
    requests,
    /** @returns {string[]} the URLs requested, in order */
    urls: () => requests.map(request => request.url),
    /** Forgets the requests made so far, keeping what is registered */
    clearRequests: () => {
      requests.length = 0
    },
  }

  for (const fixture of fixtures) {
    respond(fixture.url, fixture)
  }

  return fake
}
