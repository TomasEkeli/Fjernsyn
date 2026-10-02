// A YouTube video, fetched: its details and playback source in the common
// `VideoDetails` shape (`../shapes.js`), from Local or Invidious through the
// backend policy (`./policy.js`). The mapping is the `VideoDetails` table in
// `./types.js`.
//
// - Local: `getLocalVideoInfo(id)`. A video YouTube will not play is not a
//   thrown error there but a playability status, classified by
//   `classifyLocalPlayability` (`./errors.js`); a refusal is final, a removed
//   video `notFound` and tried once on Invidious when fallback is on.
// - Invidious: `invidiousGetVideoInformation(id)`, whose errors are
//   classified by their message.

import { classifyLocalPlayability, classifyYouTubeError } from './errors'

/**
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {ReturnType<typeof import('./policy').createBackendPolicy>} deps.policy
 */
export function createYouTubeVideoReader({ youtube, policy }) {
  /**
   * @param {'local' | 'invidious'} backend
   * @param {string} id
   * @returns {Promise<import('../shapes').VideoDetails>}
   */
  async function fetchDetails(backend, id) {
    if (backend === 'local') {
      const answer = await youtube.getLocalVideoInfo(id)
      const refusal = classifyLocalPlayability(answer?.info)

      if (refusal) {
        throw refusal
      }

      return /** @type {any} */ ({ type: 'video', videoId: id, title: answer.info.basic_info?.title ?? '' })
    }

    const video = await youtube.invidiousGetVideoInformation(id)

    return /** @type {any} */ ({ type: 'video', videoId: id, title: video?.title ?? '' })
  }

  /**
   * @param {string} id a YouTube video ref
   * @returns {Promise<import('../shapes').VideoDetails>}
   */
  function getVideo(id) {
    return policy.first(backend => fetchDetails(backend, id), classifyYouTubeError)
  }

  return Object.freeze({ getVideo })
}
