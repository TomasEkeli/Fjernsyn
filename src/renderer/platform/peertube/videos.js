// A PeerTube video, fetched: its details, playback source and download
// options, in the common `VideoDetails` shape (`../shapes.js`).
//
// - Every request goes to the video's origin. When the instance asked says
//   the video is not its own (`isLocal: false`), the details are fetched
//   again from the origin (its channel's host, else its account's, else its
//   URL's), once, and the origin's answer is the one returned.
// - Captions, chapters and storyboards are then asked of the origin in
//   parallel; chapters and storyboards only where the server version has them.
//   Each of the three is optional: a failure leaves it out, silently, and
//   never fails the video.
// - A live asks for none of them: a live now plays from its manifest alone,
//   and a waiting or ended live has nothing to play.
// - A refusal is a `PlatformError` `refused` with a `reason` where the
//   instance gives one, a missing video `notFound` (see `./client.js`).

import { PlatformError } from '../errors'
import { isPeerTubeVideoRef } from '../refs'
import { downloadOptionsFor } from './downloads'
import {
  absoluteUrl,
  channelSummary,
  commentsEnabledOf,
  isRemote,
  labelOf,
  liveStatusOf,
  originHost,
  pickAvatar,
  videoSummary,
} from './normalise'
import { playbackSourceFor } from './playback'

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T | null>}
 */
async function orNull(promise) {
  try {
    return await promise
  } catch {
    return null
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./client').createPeerTubeClient>} deps.client
 * @param {{ locale: string }} deps.config
 */
export function createVideoReader({ client, config }) {
  /**
   * @param {string} host
   * @param {string} uuid
   */
  async function fetchFromOrigin(host, uuid) {
    const first = await fetchVideo(host, uuid)

    if (!isRemote(first)) {
      return { host, video: first }
    }

    const origin = originHost(first, host)

    if (origin === host) {
      return { host, video: first }
    }

    // The client refuses a host that is never PeerTube (YouTube's, Google's)
    // as `invalid`, without a request, whatever the answer named
    return { host: origin, video: await fetchVideo(origin, uuid) }
  }

  /**
   * The details of the video asked for, or `unavailable` when the instance
   * answers with another video, or with none.
   *
   * @param {string} host
   * @param {string} uuid lower case
   */
  async function fetchVideo(host, uuid) {
    const video = await client.get(host, `/videos/${uuid}`)

    if (typeof video?.uuid !== 'string' || video.uuid.toLowerCase() !== uuid) {
      throw new PlatformError('unavailable', `${host} answered with another video than ${uuid}`, { status: 200, host })
    }

    return video
  }

  /**
   * @param {string} host
   * @param {import('./client').Feature} feature
   * @param {string} path
   */
  async function getIfSupported(host, feature, path) {
    if (!(await client.supports(host, feature))) {
      return null
    }

    return client.get(host, path)
  }

  /**
   * @param {import('../shapes').PeerTubeVideoRef} ref
   * @returns {Promise<import('../shapes').VideoDetails>}
   */
  async function getVideo(ref) {
    if (!isPeerTubeVideoRef(ref)) {
      throw new PlatformError('invalid', 'Not a PeerTube video ref')
    }

    const uuid = ref.videoId.toLowerCase()
    const { host, video } = await fetchFromOrigin(ref.host.toLowerCase(), uuid)
    const summary = videoSummary(video, host)

    if (!summary) {
      throw new PlatformError('unavailable', `${host} answered without a video`, { status: 200, host })
    }

    const liveStatus = liveStatusOf(video)

    let captions = null
    let chapters = null
    let storyboards = null

    if (liveStatus === null) {
      [captions, chapters, storyboards] = await Promise.all([
        orNull(client.get(host, `/videos/${uuid}/captions`)),
        orNull(getIfSupported(host, 'chapters', `/videos/${uuid}/chapters`)),
        orNull(getIfSupported(host, 'storyboards', `/videos/${uuid}/storyboards`)),
      ])
    }

    const channel = channelSummary(video.channel, host)

    return {
      ...summary,
      // The origin, whatever the details' own fields say
      host,
      description: typeof video.description === 'string' ? video.description : '',
      descriptionKind: 'markdown',
      likeCount: typeof video.likes === 'number' ? video.likes : null,
      dislikeCount: typeof video.dislikes === 'number' ? video.dislikes : null,
      tags: Array.isArray(video.tags) ? video.tags.filter(tag => typeof tag === 'string') : [],
      category: labelOf(video.category),
      licence: labelOf(video.licence),
      language: labelOf(video.language),
      url: canonicalUrl(video, host, uuid),
      channel,
      authorThumbnail: channel?.thumbnail || pickAvatar(video.account, host),
      commentsEnabled: commentsEnabledOf(video),
      downloadEnabled: video.downloadEnabled === true,
      liveStatus,
      playbackSource: playbackSourceFor(video, host, liveStatus, {
        captions,
        chapters,
        storyboards,
        locale: config.locale,
      }),
      downloadOptions: downloadOptionsFor(video, host),
    }
  }

  return Object.freeze({ getVideo })
}

/**
 * The video's own URL on its origin, or the watch URL built from the uuid.
 *
 * @param {any} video
 * @param {string} host
 * @param {string} uuid
 * @returns {string}
 */
function canonicalUrl(video, host, uuid) {
  return absoluteUrl(host, video.url) ?? `https://${host}/videos/watch/${uuid}`
}
