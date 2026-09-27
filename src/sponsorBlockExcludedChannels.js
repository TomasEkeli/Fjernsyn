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
 * @typedef {{ id: string, name?: string, thumbnail?: string }} SubscribedChannel
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

/**
 * @param {string} name
 */
function comparable(name) {
  return name.normalize('NFC').trim().toLocaleLowerCase()
}

/**
 * The subscribed channels called exactly this, ignoring case. More than one
 * means the name alone cannot say which channel was meant.
 * @param {SubscribedChannel[]} subscriptions
 * @param {string} text
 * @returns {SubscribedChannel[]}
 */
export function subscribedChannelsNamed(subscriptions, text) {
  const wanted = comparable(text)

  if (wanted === '') {
    return []
  }

  return subscriptions.filter(channel => {
    return typeof channel.name === 'string' && comparable(channel.name) === wanted
  })
}

/**
 * The channel id that typed text stands for, when it is the name of exactly one
 * subscribed channel. Anything else is for the caller to read as an id or a
 * URL, as it would have without this.
 * @param {SubscribedChannel[]} subscriptions
 * @param {string} text
 * @returns {string | null}
 */
export function resolveSubscribedChannelId(subscriptions, text) {
  const matches = subscribedChannelsNamed(subscriptions, text)
  return matches.length === 1 ? matches[0].id : null
}

/**
 * Names of the subscribed channels not already on the list, for the input to
 * suggest as it is typed into. A name two channels share is left out, since
 * picking it could not say which of them was meant.
 * @param {SubscribedChannel[]} subscriptions
 * @param {ExcludedChannel[]} list
 * @param {Intl.Collator} [collator]
 * @returns {string[]}
 */
export function exclusionSuggestions(subscriptions, list, collator = new Intl.Collator()) {
  /** @type {Map<string, { name: string, count: number, excluded: boolean }>} */
  const byName = new Map()

  for (const channel of subscriptions) {
    if (typeof channel.name !== 'string' || channel.name.trim() === '') {
      continue
    }

    const key = comparable(channel.name)
    const entry = byName.get(key)

    if (entry) {
      entry.count++
    } else {
      byName.set(key, {
        name: channel.name.trim(),
        count: 1,
        excluded: isExcludedChannel(list, channel.id)
      })
    }
  }

  return [...byName.values()]
    .filter(entry => entry.count === 1 && !entry.excluded)
    .map(entry => entry.name)
    .sort(collator.compare)
}

/**
 * The few suggestions worth showing for what has been typed so far. With
 * hundreds of subscriptions, one typed letter matches most of them, and the
 * input would list every one.
 *
 * Matching is by lower cased substring, as the input's own filtering is, so
 * that it keeps every name given here. Names starting with the text come first,
 * then names with a word starting with it, then the rest, each in the order
 * given.
 * @param {string[]} names
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function suggestionsMatching(names, text, limit = 10) {
  const wanted = text.toLowerCase()

  if (wanted.trim() === '') {
    return []
  }

  const ranked = [[], [], []]

  for (const name of names) {
    const lower = name.toLowerCase()
    const index = lower.indexOf(wanted)

    if (index === -1) {
      continue
    }

    if (index === 0) {
      ranked[0].push(name)
    } else if (/[\s\p{P}]/u.test(lower[index - 1])) {
      ranked[1].push(name)
    } else {
      ranked[2].push(name)
    }
  }

  return ranked.flat().slice(0, limit)
}
