/**
 * The rules behind the SponsorBlock excluded channels list: channels whose
 * segments are still drawn on the seek bar but never skipped past.
 *
 * The list is upstream's `sponsorBlockExcludedChannels` setting, a JSON string
 * holding the same tag shape as the hidden channels list: `name` is the channel
 * id, `preferredName` the name shown for it, and `icon` and `iconHref` are
 * filled in once someone has looked the channel up.
 *
 * This lives outside both the store and the datastore because both need it: the
 * settings page, the watch and channel page buttons, and the one time migration
 * of the fork's own list, which the datastore runs before the store exists.
 */

/**
 * @typedef {{
 *   name: string,
 *   preferredName?: string,
 *   icon?: string,
 *   iconHref?: string,
 *   invalid?: boolean
 * }} ExcludedChannel
 */

/**
 * The setting as a list, whatever state it is in. A value that does not parse,
 * or parses to something other than a list, counts as an empty list, so that
 * a damaged setting cannot take the settings page or the player down with it.
 * @param {string | undefined | null} json
 * @returns {ExcludedChannel[]}
 */
export function parseExcludedChannels(json) {
  if (typeof json !== 'string' || json === '') {
    return []
  }

  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * @param {ExcludedChannel[]} list
 * @param {string} channelId
 * @returns {boolean}
 */
export function isExcludedChannel(list, channelId) {
  if (!channelId) {
    return false
  }

  return list.some(channel => channel.name === channelId)
}

/**
 * The list with the channel on it, unchanged if it already was.
 * @param {ExcludedChannel[]} list
 * @param {string} channelId
 * @param {string} [channelName]
 * @returns {ExcludedChannel[]}
 */
export function withChannelExcluded(list, channelId, channelName = '') {
  if (!channelId || isExcludedChannel(list, channelId)) {
    return list
  }

  return [...list, { name: channelId, preferredName: channelName }]
}

/**
 * @param {ExcludedChannel[]} list
 * @param {string} channelId
 * @returns {ExcludedChannel[]}
 */
export function withoutChannel(list, channelId) {
  return list.filter(channel => channel.name !== channelId)
}

/**
 * Carries the fork's own never-skip list, `sponsorBlockMarkOnlyChannels`, over
 * into upstream's list, which replaced it. Entries already on upstream's list
 * stay as they are, icons included.
 * @param {ExcludedChannel[]} list
 * @param {unknown} markOnlyChannels the old setting's value, a list of
 * `{ id, name }`, trusted no further than that
 * @returns {ExcludedChannel[]}
 */
export function mergeMarkOnlyChannels(list, markOnlyChannels) {
  if (!Array.isArray(markOnlyChannels)) {
    return list
  }

  let merged = list

  for (const channel of markOnlyChannels) {
    if (channel === null || typeof channel !== 'object' || typeof channel.id !== 'string') {
      continue
    }

    // The old list stored the id in place of a name it did not have, and a
    // name that is only the id again would stop the settings page from
    // looking the real one up.
    const name = typeof channel.name === 'string' && channel.name !== channel.id
      ? channel.name
      : ''

    merged = withChannelExcluded(merged, channel.id, name)
  }

  return merged
}
