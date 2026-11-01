/**
 * The source chips on Collections: one per followed source, any number of
 * them on, deciding which sources' videos the wall shows and never what is
 * fetched, as the subscriptions page's kind chips and Explore's category
 * chips do.
 *
 * The choice is kept as the sources switched off (the
 * `collectionsSourcesHidden` setting), not those on, so that a source followed
 * later arrives with its chip on, as a new Explore category does. A source
 * followed again after it was unfollowed with its chip off is a newly followed
 * source too: following takes its id out of the setting
 * (store/modules/collections.js, `followCollectionSource`).
 *
 * Pure: the setting is read and written by the caller.
 */

/** @typedef {import('./shares').Source} Source */

/**
 * @param {unknown} hidden the setting as stored
 * @returns {readonly string[]}
 */
function hiddenList(hidden) {
  return Array.isArray(hidden) ? hidden : []
}

/**
 * The sources whose videos Collections shows: every source followed whose
 * chip is not off. A source not followed is never among them, whatever the
 * setting holds of it.
 *
 * @param {readonly Source[]} sources the sources followed
 * @param {readonly string[]} hidden the ids of the sources switched off
 * @returns {Set<string>}
 */
export function shownSourceIds(sources, hidden) {
  const off = new Set(hiddenList(hidden))

  return new Set(sources.map(source => source._id).filter(id => !off.has(id)))
}

/**
 * The sources switched off once a source's chip is turned on or off: a new
 * list, or the one given when the chip is already so.
 *
 * @param {readonly string[]} hidden
 * @param {string} sourceId
 * @param {boolean} shown
 * @returns {readonly string[]}
 */
export function hiddenSourcesWith(hidden, sourceId, shown) {
  const list = hiddenList(hidden)

  if (shown === !list.includes(sourceId)) {
    return hidden
  }

  return shown ? list.filter(id => id !== sourceId) : [...list, sourceId]
}

/**
 * Sources, or anything named as one, by name, whatever the case: the order
 * of the chips and of the Sources page's list, so that the two agree.
 *
 * @template {{ name: string }} T
 * @param {readonly T[]} sources
 * @returns {T[]}
 */
export function sourcesByName(sources) {
  return [...sources].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}
