// Stored records of more than one platform, where upstream's code treats
// every record as YouTube's: what an import keeps of a PeerTube record, and
// which records a YouTube-only path (a YouTube-format export, the YouTube
// watch page's playlist) takes.
//
// A record without `platform` is YouTube (spec, Refs and stored shapes), and
// every function here hands it back or answers for it as upstream's code
// would, untouched: a hook reads `split.record` or filters with
// `isYouTubeRecord`, so a YouTube record takes exactly today's path.

import { isHostname, isUuid, parseChannelHandle, peerTubeChannelRef, PLATFORM_PEERTUBE, PLATFORM_YOUTUBE, platformOf } from './refs'

// The fields a stored PeerTube video carries beyond a YouTube one
const PLATFORM_KEYS = ['platform', 'host', 'thumbnail', 'authorThumbnail']
const URL_KEYS = ['thumbnail', 'authorThumbnail']

/**
 * @param {unknown} record
 * @returns {boolean} whether the record is YouTube's; a record without `platform` is
 */
export function isYouTubeRecord(record) {
  return platformOf(record) === PLATFORM_YOUTUBE
}

/**
 * Splits an imported record into what upstream's import validates as it
 * always has, and the platform fields it does not know, validated. A PeerTube
 * record needs a host name, a uuid for its `videoId` (stored in lower case,
 * as the layer writes one) and a channel handle for its `authorId` (stored as
 * `name@host`, the host in lower case); its thumbnails are kept only as
 * `https:` URLs, and dropped otherwise.
 *
 * @param {Record<string, any>} imported one record as parsed from the file; not changed
 * @returns {{ record: Record<string, any>, fields: Record<string, any> | null }}
 *   for a YouTube record, the record itself and `{}`; for a PeerTube one, a
 *   copy without the platform keys and the fields to keep, or `fields: null`
 *   when it cannot be a PeerTube record and must be skipped
 */
export function splitImportedPlatformFields(imported) {
  if (imported?.platform !== PLATFORM_PEERTUBE) {
    return { record: imported, fields: {} }
  }

  const record = { ...imported }
  for (const key of PLATFORM_KEYS) {
    delete record[key]
  }

  const channel = parseChannelHandle(imported.authorId)
  const authorId = channel && peerTubeChannelRef(channel.name, channel.host)

  if (!isHostname(imported.host) || !isUuid(imported.videoId) || !authorId) {
    return { record, fields: null }
  }

  record.videoId = imported.videoId.toLowerCase()
  record.authorId = authorId

  const fields = { platform: PLATFORM_PEERTUBE, host: imported.host }
  for (const key of URL_KEYS) {
    if (isHttpsUrl(imported[key])) {
      fields[key] = imported[key]
    }
  }

  return { record, fields }
}

/**
 * An imported playlist video as it is to be stored. Upstream keeps a
 * playlist video whole, so a YouTube one still is.
 *
 * @param {Record<string, any>} video
 * @returns {Record<string, any> | null} the YouTube video itself; a PeerTube one with only valid platform fields; `null` for a PeerTube video that cannot be one
 */
export function importedPlaylistVideo(video) {
  const { record, fields } = splitImportedPlatformFields(video)

  if (fields === null) {
    return null
  }

  return record === video ? video : { ...record, ...fields }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isHttpsUrl(value) {
  if (typeof value !== 'string') {
    return false
  }

  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
