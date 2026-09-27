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
 * or parses to something other than a list, counts as an empty list, and an
 * entry with no channel id in it is dropped, so that a damaged setting cannot
 * take the settings page, the player or the loading of settings down with it.
 * @param {string | undefined | null} json
 * @returns {ExcludedChannel[]}
 */
export function parseExcludedChannels(json) {
  if (typeof json !== 'string' || json === '') {
    return []
  }

  let parsed

  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed.filter(channel => {
    return channel !== null && typeof channel === 'object' && typeof channel.name === 'string'
  })
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
 * The subscribed channels called exactly this, ignoring case and how accents
 * are composed. More than one means the name alone cannot say which channel
 * was meant.
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
 * Every subscribed channel with a name, as the text that stands for it: the
 * name, or where two channels share a name, the name with the channel id after
 * it in brackets, since nothing else stored about a channel tells them apart.
 * @param {SubscribedChannel[]} subscriptions
 * @param {Intl.Collator} [collator]
 * @returns {{ id: string, label: string }[]} in label order
 */
export function subscribedChannelLabels(subscriptions, collator = new Intl.Collator()) {
  const named = subscriptions.filter(channel => {
    return typeof channel.id === 'string' && typeof channel.name === 'string' && channel.name.trim() !== ''
  })

  /** @type {Map<string, number>} */
  const counts = new Map()

  for (const channel of named) {
    const key = comparable(channel.name)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return named
    .map(channel => {
      const name = channel.name.trim()
      const shared = counts.get(comparable(name)) > 1

      return { id: channel.id, label: shared ? `${name} (${channel.id})` : name }
    })
    .sort((a, b) => collator.compare(a.label, b.label))
}

/**
 * What typed text stands for among the subscribed channels:
 * - a channel's label from `subscribedChannelLabels`, as picking a suggestion
 *   gives, is that channel
 * - otherwise the name of exactly one subscribed channel, ignoring case, is
 *   that channel
 * - a name more than one channel has is ambiguous, and the caller can say so
 * - anything else is null, for the caller to read as an id or a URL, as it
 *   would have without this
 * @param {SubscribedChannel[]} subscriptions
 * @param {string} text
 * @returns {{ id: string } | { ambiguous: true, name: string } | null} with the
 * name as the first of the channels sharing it has it, for saying which it was
 */
export function resolveSubscribedChannel(subscriptions, text) {
  const wanted = text.normalize('NFC').trim()

  if (wanted === '') {
    return null
  }

  const labelled = subscribedChannelLabels(subscriptions).find(entry => entry.label.normalize('NFC') === wanted)

  if (labelled) {
    return { id: labelled.id }
  }

  const matches = subscribedChannelsNamed(subscriptions, text)

  if (matches.length === 1) {
    return { id: matches[0].id }
  }

  return matches.length > 1 ? { ambiguous: true, name: matches[0].name.trim() } : null
}

/**
 * Labels of the subscribed channels not already on the list, for the input to
 * suggest as it is typed into.
 * @param {SubscribedChannel[]} subscriptions
 * @param {ExcludedChannel[]} list
 * @param {Intl.Collator} [collator]
 * @returns {string[]}
 */
export function exclusionSuggestions(subscriptions, list, collator = new Intl.Collator()) {
  return subscribedChannelLabels(subscriptions, collator)
    .filter(entry => !isExcludedChannel(list, entry.id))
    .map(entry => entry.label)
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
