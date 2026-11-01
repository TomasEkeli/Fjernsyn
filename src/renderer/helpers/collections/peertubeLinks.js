/**
 * PeerTube links, confirmed: what a source kind's `fetch` asks of a link that
 * looks like a PeerTube video (`videoLinks.js`, `peerTubeCandidateFromLink`)
 * before it is kept as a share.
 *
 * A candidate is a host and a uuid. Asking it goes through the platform layer
 * (ADR-0014): first whether the host is PeerTube at all (`resolveUrl`, which
 * asks the host's `/api/v1/config` once per session and says nothing of a
 * host it may not ask, as while PeerTube is switched off), then for the
 * video itself (`getVideoSummary`), which comes from its origin. So the share
 * is keyed by the video's ref, its uuid and its origin host, whichever
 * instance the link was on; and the summary is what the video's details are,
 * kept at once (`details.js`), so that a video confirmed needs no more
 * asking.
 *
 * Asked as little as can be:
 *
 * - A video already shared, or with details kept, is known by its uuid,
 *   which is the same on every instance: no request at all. One kept as gone
 *   or private is skipped until that mark is stale (`needsDetails`).
 * - What each host was found to be, PeerTube or not, is remembered across
 *   sessions (`createHostMemory`, in `localStorage`: per installation, shared
 *   by its windows, never backed up, as nothing in it is more than a request
 *   saved). A host that is not PeerTube is skipped; one that is, is not asked
 *   for its config again before its video. Each answer is believed for
 *   `HOST_VERDICT_STALE_MS`, so a host that changes is found out; the memory
 *   keeps the `HOSTS_REMEMBERED` most recent.
 * - A host that could not be asked (down, refusing, rate limiting) is
 *   remembered as nothing, and its link is skipped this time only.
 *
 * Framework-free: the store hands it the layer and the rest.
 */

import { needsDetails, peerTubeFailureRecord, peerTubeRefOf, videoDetailsFromPeerTubeSummary, videoDetailsRecord } from './details.js'

/** @import { VideoDetails } from './details.js' */
/** @import { Share } from './shares.js' */
/** @typedef {import('../../platform/shapes').PeerTubeVideoRef} PeerTubeVideoRef */

/** How long what a host was found to be is believed */
export const HOST_VERDICT_STALE_MS = 30 * 24 * 60 * 60 * 1000

/** How many hosts are remembered, the most recently asked */
export const HOSTS_REMEMBERED = 500

/** Where the hosts are remembered */
export const PEERTUBE_HOSTS_KEY = 'collectionsPeerTubeHosts'

/**
 * @typedef {Record<string, { peertube: boolean, at: number }>} HostMemory
 * by host, whether it was PeerTube, and when that was found
 */

/**
 * What was remembered, from its text, keeping only what reads as a verdict
 *
 * @param {string | null} text
 * @returns {HostMemory}
 */
export function readHostMemory(text) {
  let parsed
  try {
    parsed = JSON.parse(text ?? '{}')
  } catch {
    return {}
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { return {} }

  /** @type {HostMemory} */
  const memory = {}

  for (const [host, verdict] of Object.entries(parsed)) {
    if (typeof verdict?.peertube === 'boolean' && Number.isFinite(verdict?.at)) {
      memory[host] = { peertube: verdict.peertube, at: verdict.at }
    }
  }

  return memory
}

/**
 * What a host was found to be, while that is still believed: true for
 * PeerTube, false for not, null for not known
 *
 * @param {HostMemory} memory
 * @param {string} host
 * @param {number} now
 * @returns {boolean | null}
 */
export function hostVerdict(memory, host, now) {
  const verdict = Object.hasOwn(memory, host) ? memory[host] : undefined

  if (verdict === undefined || verdict.at > now || now - verdict.at > HOST_VERDICT_STALE_MS) { return null }

  return verdict.peertube
}

/**
 * The memory with what a host was found to be, and no more than
 * `HOSTS_REMEMBERED` hosts: the longest unasked go first
 *
 * @param {HostMemory} memory
 * @param {string} host
 * @param {boolean} peertube
 * @param {number} now
 * @returns {HostMemory}
 */
export function withHostVerdict(memory, host, peertube, now) {
  const entries = Object.entries({ ...memory, [host]: { peertube, at: now } })

  if (entries.length <= HOSTS_REMEMBERED) { return Object.fromEntries(entries) }

  entries.sort(([, a], [, b]) => b.at - a.at)
  return Object.fromEntries(entries.slice(0, HOSTS_REMEMBERED))
}

/**
 * The hosts remembered, read and written through the storage given, so that
 * another window's findings are taken in. A storage that cannot be read or
 * written remembers nothing, and asks again.
 *
 * @param {Pick<Storage, 'getItem' | 'setItem'>} storage
 */
export function createHostMemory(storage) {
  function read() {
    try {
      return readHostMemory(storage.getItem(PEERTUBE_HOSTS_KEY))
    } catch {
      return {}
    }
  }

  return Object.freeze({
    /**
     * @param {string} host
     * @param {number} now
     */
    verdict: (host, now) => hostVerdict(read(), host, now),

    /**
     * @param {string} host
     * @param {boolean} peertube
     * @param {number} now
     */
    remember: (host, peertube, now) => {
      try {
        storage.setItem(PEERTUBE_HOSTS_KEY, JSON.stringify(withHostVerdict(read(), host, peertube, now)))
      } catch {
        // Not remembered: asked again next time
      }
    },
  })
}

/**
 * @typedef {object} KnownVideo what is kept of a PeerTube video, found by its uuid
 * @property {PeerTubeVideoRef} ref
 * @property {boolean} shared whether a share names it
 * @property {VideoDetails} [record] its details, if any are kept
 */

/**
 * The PeerTube videos the shares and details kept name, by uuid, which is the
 * same whichever instance a link to one is on
 *
 * @param {Share[]} shares
 * @param {Record<string, VideoDetails>} details
 * @returns {Map<string, KnownVideo>}
 */
export function knownPeerTubeVideos(shares, details) {
  /** @type {Map<string, KnownVideo>} */
  const known = new Map()

  for (const record of Object.values(details)) {
    if (record?.platform === 'peertube' && typeof record.host === 'string') {
      known.set(record.videoId, { ref: peerTubeRefOf(record), shared: false, record })
    }
  }

  for (const share of shares) {
    if (share.platform !== 'peertube' || typeof share.host !== 'string') { continue }

    const kept = known.get(share.videoId)
    // A share names the video by its origin, as its details do
    known.set(share.videoId, { ...kept, ref: peerTubeRefOf(share), shared: true })
  }

  return known
}

/**
 * @typedef {object} PeerTubeLinkDependencies
 * @property {() => boolean} enabled whether PeerTube is switched on: off, no
 *   link is taken for PeerTube, and nothing is asked
 * @property {() => Map<string, KnownVideo>} known the videos kept, by uuid
 *   (`knownPeerTubeVideos`), read once, on the first link asked about
 * @property {{ verdict: (host: string, now: number) => boolean | null, remember: (host: string, peertube: boolean, now: number) => void }} hosts
 *   what each host was found to be (`createHostMemory`)
 * @property {(url: string) => Promise<any>} resolveUrl the layer's: a
 *   resolution for a PeerTube URL on a host confirmed as PeerTube, null for a
 *   host that is not, and rejects when the host could not be asked
 * @property {(ref: PeerTubeVideoRef) => Promise<import('../../platform/shapes').VideoSummary>} getVideoSummary the layer's
 * @property {(records: VideoDetails[]) => Promise<void>} putDetails keeps details
 * @property {() => number} now
 * @property {(message: string, error?: unknown) => void} [onFailure]
 */

/**
 * The ref each PeerTube candidate is, asked of the platform layer as little
 * as can be (see the top of this file). One answer per uuid for the life of
 * the resolver, which is one refresh: a video posted twice is asked about
 * once.
 *
 * @param {PeerTubeLinkDependencies} deps
 */
export function createPeerTubeLinkResolver({ enabled, known, hosts, resolveUrl, getVideoSummary, putDetails, now, onFailure = () => {} }) {
  /** @type {Map<string, KnownVideo> | null} */
  let kept = null

  /** @type {Map<string, Promise<PeerTubeVideoRef | null>>} */
  const answers = new Map()

  /**
   * @param {{ host: string, videoId: string }} candidate
   * @returns {Promise<PeerTubeVideoRef | null>}
   */
  async function ask({ host, videoId }) {
    kept ??= known()
    const video = kept.get(videoId)

    if (video?.shared) { return video.ref }

    if (video?.record !== undefined) {
      if (video.record.unavailable === undefined) { return video.ref }
      // Gone or private, until the mark is stale
      if (!needsDetails(video.record, now())) { return null }
    }

    const verdict = hosts.verdict(host, now())
    if (verdict === false) { return null }

    /** @type {PeerTubeVideoRef} */
    let ref = { platform: 'peertube', host, videoId }

    if (verdict !== true) {
      let resolution
      try {
        resolution = await resolveUrl(`https://${host}/videos/watch/${videoId}`)
      } catch (error) {
        onFailure(`Collections: could not ask ${host} whether it is PeerTube; its link is skipped this time`, error)
        return null
      }

      if (resolution?.kind !== 'video') {
        hosts.remember(host, false, now())
        return null
      }

      hosts.remember(host, true, now())
      ref = resolution.ref
    }

    let summary
    try {
      summary = await getVideoSummary(ref)
    } catch (error) {
      const record = peerTubeFailureRecord(ref, error, now())
      if (record !== null) { await keep(record) }
      onFailure(`Collections: could not have ${videoId} from ${host}${record === null ? '; it is asked again next time' : `; kept as ${record.unavailable}`}`, error)
      return null
    }

    const confirmed = peerTubeRefOf(summary)
    await keep(videoDetailsRecord(confirmed, videoDetailsFromPeerTubeSummary(summary), now()))

    return confirmed
  }

  /**
   * Keeps a record, and only says so when it cannot: the share is kept all
   * the same, and the details are asked for again (`peertubeDetails.js`)
   *
   * @param {VideoDetails} record
   */
  async function keep(record) {
    try {
      await putDetails([record])
    } catch (error) {
      onFailure(`Collections: could not keep the details of ${record._id}`, error)
    }
  }

  return Object.freeze({
    /**
     * The ref a candidate is, the video's uuid and its origin host, or null
     * when it is not a PeerTube video that can be had: the host is not
     * PeerTube, or could not be asked, or the video is gone or refused, or
     * PeerTube is switched off. Never rejects.
     *
     * @param {{ host: string, videoId: string }} candidate
     * @returns {Promise<PeerTubeVideoRef | null>}
     */
    refFor(candidate) {
      if (!enabled()) { return Promise.resolve(null) }

      let answer = answers.get(candidate.videoId)

      if (answer === undefined) {
        answer = ask(candidate)
        answers.set(candidate.videoId, answer)
      }

      return answer
    },
  })
}
