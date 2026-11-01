/**
 * Whether a record a renderer asks main to write to a communities datastore
 * may be written: an object with a string `_id`, and no top-level field
 * starting with `$`, which nedb would take for an update operator. A video's
 * details must also name the video.
 *
 * @param {unknown} value
 * @param {{ videoId?: boolean }} [options]
 * @returns {boolean}
 */
export function isStorableCommunityRecord(value, { videoId = false } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return false }

  const record = /** @type {Record<string, unknown>} */ (value)

  if (typeof record._id !== 'string') { return false }
  if (Object.keys(record).some(key => key.startsWith('$'))) { return false }
  if (videoId && typeof record.videoId !== 'string') { return false }

  return true
}
