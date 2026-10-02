// A fake `youtube` dependency object for the YouTube adapters' tests,
// answering from fixtures (`../fixtures/*.json`) and recording every call, so
// that tests can assert on what was asked (or that nothing was).
//
//   import localVideo from '../fixtures/local--video-ordinary.json'
//   const fake = createFakeYouTube({ getLocalVideoInfo: localVideo })
//   fake.respond('invidiousGetVideoInformation', new Error('Video unavailable'))
//   fake.respond('parseLocalTextRuns', runs => runs.map(run => run.text).join(''))
//   const layer = createPlatformLayer({ youtube: fake.youtube, config })
//   ...
//   expect(fake.callsOf('getLocalVideoInfo')).toEqual([['dQw4w9WgXcQ']])
//
// An answer is one of:
// - a fixture (`{ recordedAt, source, call, answer }`): the call resolves to
//   a fresh deep copy of its `answer`, since the modules' answers are theirs
//   to mutate and a test must not see another's changes
// - an Error: the call rejects with it, as the module would throw
// - a function: called with the arguments, its result returned as it is.
//   This is how a test hands in a synchronous helper (often the real one), a
//   library instance with methods, or answers that differ by argument
//
// A function nothing is registered for throws, naming itself, and is still
// recorded.

/**
 * @typedef {object} YouTubeFixture
 * @property {string} recordedAt ISO date
 * @property {'recorded' | 'synthesised'} source recorded from the live
 *   service, or written from its documented shape where it could not be
 * @property {string} call the module call it answers, as written
 * @property {unknown} answer what the module function answered, trimmed to
 *   the fields the adapters read
 */

/** @typedef {YouTubeFixture | Error | ((...args: any[]) => unknown)} FakeAnswer */

/**
 * @param {FakeAnswer} answer
 * @param {any[]} args
 */
function answerWith(answer, args) {
  if (answer instanceof Error) {
    return Promise.reject(answer)
  }

  if (typeof answer === 'function') {
    return answer(...args)
  }

  return Promise.resolve(structuredClone(/** @type {YouTubeFixture} */ (answer).answer))
}

/**
 * @param {Record<string, FakeAnswer>} [answers] by module function name
 */
export function createFakeYouTube(answers = {}) {
  /** @type {Map<string, FakeAnswer>} */
  const registered = new Map(Object.entries(answers))
  /** @type {{ name: string, args: any[] }[]} */
  const calls = []

  const youtube = new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string') {
        return undefined
      }

      return (...args) => {
        calls.push({ name, args })

        if (!registered.has(name)) {
          throw new Error(`fakeYouTube: no answer registered for youtube.${name}`)
        }

        return answerWith(registered.get(name), args)
      }
    },
    has: (_target, name) => registered.has(String(name)),
  })

  return {
    /** The `youtube` dependency object to hand the layer */
    youtube,
    /** Every call, in order */
    calls,
    /**
     * @param {string} name
     * @param {FakeAnswer} answer
     */
    respond(name, answer) {
      registered.set(name, answer)
    },
    /**
     * The arguments of every call of one function, in order.
     *
     * @param {string} name
     * @returns {any[][]}
     */
    callsOf(name) {
      return calls.filter(call => call.name === name).map(call => call.args)
    },
  }
}

/**
 * A fixture's answer with methods added, for a module that answers a
 * library instance (a `YT.VideoInfo`'s `toDash`, a `YT.Channel`'s
 * `getVideos`): a fresh deep copy of the answer, then the methods.
 *
 * @param {YouTubeFixture} fixture
 * @param {(answer: any) => Record<string, Function>} methodsFor given the copy, the methods to add
 */
export function withMethods(fixture, methodsFor) {
  const answer = structuredClone(fixture.answer)
  return Object.assign(answer, methodsFor(answer))
}
