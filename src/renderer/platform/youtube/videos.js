// A YouTube video, fetched: its details and playback source in the common
// `VideoDetails` shape (`../shapes.js`), from Local or Invidious through the
// backend policy (`./policy.js`). The mapping is the `VideoDetails` table in
// `./types.js`, read in `./videoDetails.js`; the playback source and the
// chapters' kind are built in `./playback.js`.
//
// - Local: `getLocalVideoInfo(id)`. A video YouTube will not play is not a
//   thrown error there but a playability status, classified by
//   `classifyLocalPlayability` (`./errors.js`); a refusal is final. A removed
//   video is the exception: youtubei.js throws for its `ERROR` status before
//   `getLocalVideoInfo` can answer, with the status on the error's `info`,
//   which is read the same way, as `notFound`, and tried once on Invidious
//   when fallback is on.
// - Invidious: `invidiousGetVideoInformation(id)`, whose errors are
//   classified by their message.

import { PlatformError } from '../errors'
import { classifyLocalPlayability, classifyYouTubeError } from './errors'
import { invidiousPlayback, localPlayback } from './playback'
import { invidiousVideoDetails, localVideoDetails } from './videoDetails'

/**
 * youtubei.js' error for a video whose playability is `ERROR`, as the
 * playability it carries; anything else as it is.
 *
 * @param {any} error
 */
function removedVideoOr(error) {
  return error?.info?.status === 'ERROR'
    ? classifyLocalPlayability({ playability_status: error.info }) ?? error
    : error
}

/**
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {Readonly<import('../index').PlatformConfig>} deps.config
 * @param {ReturnType<typeof import('./policy').createBackendPolicy>} deps.policy
 */
export function createYouTubeVideoReader({ youtube, config, policy }) {
  const readers = { youtube, config }

  /**
   * @param {string} id
   * @returns {Promise<import('../shapes').VideoDetails>}
   */
  async function fromLocal(id) {
    let answer

    try {
      answer = await youtube.getLocalVideoInfo(id)
    } catch (error) {
      throw removedVideoOr(error)
    }

    if (!answer?.info) {
      throw new PlatformError('unavailable', `YouTube (Local) answered no video for ${id}`)
    }

    const refusal = classifyLocalPlayability(answer.info)

    if (refusal) {
      throw refusal
    }

    const details = localVideoDetails(id, answer, readers)
    return { ...details, ...(await localPlayback(id, answer, readers, details.liveStatus)) }
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../shapes').VideoDetails>}
   */
  async function fromInvidious(id) {
    const video = await youtube.invidiousGetVideoInformation(id)

    if (video == null || typeof video !== 'object') {
      throw new PlatformError('unavailable', `YouTube (Invidious) answered no video for ${id}`)
    }

    const details = invidiousVideoDetails(id, video, readers)
    return { ...details, ...(await invidiousPlayback(id, video, readers, details.liveStatus)) }
  }

  /**
   * @param {string} id a YouTube video ref
   * @returns {Promise<import('../shapes').VideoDetails>}
   */
  function getVideo(id) {
    return policy.first(backend => backend === 'local' ? fromLocal(id) : fromInvidious(id), classifyYouTubeError)
  }

  return Object.freeze({ getVideo })
}
