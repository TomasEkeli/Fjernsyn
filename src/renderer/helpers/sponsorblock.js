import store from '../store/index'
import {
  isExcludedChannel,
  parseExcludedChannels,
  withChannelExcluded,
  withoutChannel
} from '../../sponsorBlockExcludedChannels'

/**
 * The channels whose segments are marked on the seek bar but never skipped.
 * Reads the setting through the store getter, so callers that ask inside a
 * computed stay reactive to the list changing.
 */
export function getSponsorBlockExcludedChannels() {
  return parseExcludedChannels(store.getters.getSponsorBlockExcludedChannels)
}

/**
 * @param {string} channelId
 * @returns {boolean}
 */
export function isSponsorBlockExcludedChannel(channelId) {
  return isExcludedChannel(getSponsorBlockExcludedChannels(), channelId)
}

/**
 * Put the channel on the excluded list, or take it off again if it is already
 * on it.
 * @param {string} channelId
 * @param {string} channelName stored so the settings list has a name to show
 * before the channel has been looked up
 * @returns {Promise<boolean>} whether the channel is on the list afterwards.
 * Read back from the store rather than assumed, because the updater reports a
 * failed write by logging it and leaving the setting alone, so the only honest
 * answer is the one the store gives once the write has been tried.
 */
export async function toggleSponsorBlockExcludedChannel(channelId, channelName) {
  if (!channelId) {
    return false
  }

  const list = getSponsorBlockExcludedChannels()

  const newList = isExcludedChannel(list, channelId)
    ? withoutChannel(list, channelId)
    : withChannelExcluded(list, channelId, channelName)

  await store.dispatch('updateSponsorBlockExcludedChannels', JSON.stringify(newList))

  return isSponsorBlockExcludedChannel(channelId)
}

async function getVideoHash(videoId) {
  const videoIdBuffer = new TextEncoder().encode(videoId)

  const hashBuffer = await crypto.subtle.digest('SHA-256', videoIdBuffer)
  const hashArray = new Uint8Array(hashBuffer)

  return hashArray[0].toString(16).padStart(2, '0') +
    hashArray[1].toString(16).padStart(2, '0')
}

/**
 * @typedef {'sponsor' | 'selfpromo' | 'interaction' | 'intro' | 'outro' | 'preview' | 'music_offtopic' | 'filler'} SponsorBlockCategory
 */

/**
 * @param {string} videoId
 * @param {SponsorBlockCategory[]} categories
 * @returns {Promise<{
 *   UUID: string,
 *   actionType: string,
 *   category: SponsorBlockCategory,
 *   description: string,
 *   locked: 1|0,
 *   segment: [
 *     number,
 *     number
 *   ],
 *   videoDuration: number,
 *   votes: number
 * }[]>}
 */
export async function sponsorBlockSkipSegments(videoId, categories) {
  const videoIdHashPrefix = await getVideoHash(videoId)
  const requestUrl = `${store.getters.getSponsorBlockUrl}/api/skipSegments/${videoIdHashPrefix}?categories=${JSON.stringify(categories)}`

  try {
    const response = await fetch(requestUrl)

    // 404 means that there are no segments registered for the video
    if (response.status === 404) {
      return []
    }

    // Sometimes the sponsor block server goes down or returns other errors
    if (!response.ok) {
      throw new Error(await response.text())
    }

    const json = await response.json()
    return json
      .filter((result) => result.videoID === videoId)
      .flatMap((result) => result.segments)
  } catch (error) {
    console.error('failed to fetch SponsorBlock segments', requestUrl, error)
    throw error
  }
}

export async function deArrowData(videoId) {
  const videoIdHashPrefix = await getVideoHash(videoId)
  const requestUrl = `${store.getters.getSponsorBlockUrl}/api/branding/${videoIdHashPrefix}`

  try {
    const response = await fetch(requestUrl)

    // 404 means that there are no segments registered for the video
    if (response.status === 404) {
      return undefined
    }

    const json = await response.json()
    return json[videoId] ?? undefined
  } catch (error) {
    console.error('failed to fetch DeArrow data', requestUrl, error)
    throw error
  }
}

export async function deArrowThumbnail(videoId, timestamp) {
  let requestUrl = `${store.getters.getDeArrowThumbnailGeneratorUrl}/api/v1/getThumbnail?videoID=` + videoId
  if (timestamp != null) {
    requestUrl += `&time=${timestamp}`
  }

  try {
    const response = await fetch(requestUrl)

    // 204 means that there are no thumbnails found for the video
    if (response.status === 204) {
      return undefined
    }

    if (response.ok) {
      return response.url
    }

    // this usually means that a thumbnail was not generated on the server yet so we'll log the error but otherwise ignore it.
    const json = await response.json()
    console.error(json)
    return undefined
  } catch (error) {
    console.error('failed to fetch DeArrow data', requestUrl, error)
    throw error
  }
}
