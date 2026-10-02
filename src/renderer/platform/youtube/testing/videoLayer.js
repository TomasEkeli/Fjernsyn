// What the YouTube video tests share (`../videos.test.js`,
// `../playback.test.js`): a layer over the fake `youtube` deps with the
// modules' real helpers, and the Local answer as the library instance
// `getLocalVideoInfo` answers.

import { sortCaptions } from '../../../helpers/player/utils'
import { buildVTTFileLocally, extractNumberFromString, formatDurationAsTimestamp } from '../../../helpers/utils'
import { mapLocalLegacyFormat, parseLocalSubscriberCount, parseLocalTextRuns } from '../../../helpers/api/local'
import {
  convertInvidiousToLocalFormat,
  generateInvidiousDashManifestLocally,
  mapInvidiousLegacyFormat,
  youtubeImageUrlToInvidious,
} from '../../../helpers/api/invidious'
import { createPlatformLayer } from '../../index'
import { createFakeYouTube, withMethods } from './fakeYouTube'

export const INSTANCE = 'https://inv.example'

/** youtubei.js nodes have `is()`, which a fixture cannot carry: a stand-in that reads the id */
function parseLocalWatchNextVideo(item) {
  const videoId = item.content_id ?? item.video_id ?? item.id
  return videoId ? { type: 'video', videoId, title: `Next ${videoId}` } : null
}

/**
 * `getProxyUrl` reads the instance from the store: a stand-in that shows it
 * was asked
 *
 * @param {string} url
 */
export function getProxyUrl(url) {
  return `${INSTANCE}/proxied?url=${encodeURIComponent(url)}`
}

const HELPERS = {
  parseLocalTextRuns,
  parseLocalSubscriberCount,
  parseLocalWatchNextVideo,
  mapLocalLegacyFormat,
  extractNumberFromString,
  formatDurationAsTimestamp,
  buildVTTFileLocally,
  sortCaptions,
  mapInvidiousLegacyFormat,
  youtubeImageUrlToInvidious,
  convertInvidiousToLocalFormat,
  generateInvidiousDashManifestLocally,
  getProxyUrl,
}

/**
 * A stand-in for `YT.VideoInfo#toDash`, which needs the session's player:
 * a manifest naming the options and the audio tracks it was built from.
 *
 * @param {any} info
 */
export function fakeToDash(info) {
  return async (options) => {
    const tracks = (info.streaming_data?.adaptive_formats ?? [])
      .map(format => format.audio_track?.display_name)
      .filter(Boolean)

    return `<MPD thumbnails="${options.manifest_options.include_thumbnails}">${tracks.map(name => `<Label>${name}</Label>`).join('')}</MPD>`
  }
}

/**
 * The Local answer as `getLocalVideoInfo` gives it: `{ info, ... }` around a
 * `YT.VideoInfo` instance, here with `toDash` (or the given methods).
 *
 * @param {{ answer: any }} fixture
 * @param {(info: any) => Record<string, Function>} [methodsFor]
 */
export function localInstance(fixture, methodsFor = info => ({ toDash: fakeToDash(info) })) {
  return async () => {
    const { info, ...rest } = fixture.answer
    return { ...structuredClone(rest), info: withMethods({ ...fixture, answer: info }, methodsFor) }
  }
}

/**
 * A fixture with its `info` changed
 *
 * @param {{ answer: any }} fixture
 * @param {(info: any) => void} change
 */
export function localWith(fixture, change) {
  const copy = structuredClone(fixture)
  change(copy.answer.info)
  return copy
}

/**
 * @param {object} [options]
 * @param {Record<string, any>} [options.answers]
 * @param {object} [options.config]
 */
export function setUp({ answers = {}, config = {} } = {}) {
  const fake = createFakeYouTube({ ...HELPERS, ...answers })
  const layer = createPlatformLayer({
    fetch: () => Promise.reject(new TypeError('no network in tests')),
    youtube: fake.youtube,
    config: { backendPreference: 'local', backendFallback: false, currentInvidiousInstanceUrl: INSTANCE, ...config },
  })

  return { fake, layer }
}

/**
 * @param {Promise<unknown>} promise
 */
export async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}
