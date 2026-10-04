/**
 * The Later list's order and sections, worked out from its items alone.
 *
 * Pure: imports nothing that pulls in the store, i18n or the router, so that
 * it is tested on its own and used from the store, the page and the scheduler
 * alike.
 *
 * The queued items are ordered by `position`, smaller first. A move writes
 * one position, between the item's new neighbours, so that it never touches
 * another record; only when two neighbours come too close are the queued items
 * renumbered at whole numbers. The armed items ignore `position`: they are
 * ordered by their stated start time.
 */

/**
 * @typedef {object} LaterAlarm
 * @property {number} at       the stated start, ms
 * @property {number} armedAt  when it was armed, ms
 */

/**
 * @typedef {object} LaterItem
 * @property {string} _id        the video's ref: its videoId for YouTube
 * @property {string} videoId
 * @property {string} title
 * @property {string} author
 * @property {string} authorId
 * @property {number} [lengthSeconds]
 * @property {number} [viewCount]     as it was when added
 * @property {number} [published]     ms
 * @property {boolean} [isUpcoming]   as it was when added
 * @property {number} [premiereDate]  ms, the stated time when added
 * @property {number} addedAt         ms
 * @property {number} position        smaller is higher; the armed section ignores it
 * @property {LaterAlarm | null} alarm
 */

/** Two neighbours closer than this are renumbered */
export const RENUMBER_GAP = 1e-6

/** Checking starts this long before the stated time */
export const CHECK_BEFORE_MS = 2 * 60 * 1000

/** And goes on this long after it, before an item counts as Did not start */
export const CHECK_AFTER_MS = 3 * 60 * 60 * 1000

/**
 * @param {LaterItem} item
 */
export function isArmed(item) {
  return item.alarm != null
}

/**
 * The queued items, in their order: by position, ties by the newer added
 * first, as a new item goes on top.
 * @param {LaterItem[]} items
 * @returns {LaterItem[]}
 */
export function queuedInOrder(items) {
  return items
    .filter(item => !isArmed(item))
    .sort((a, b) => (a.position - b.position) || (b.addedAt - a.addedAt))
}

/**
 * The armed items, soonest first, ties by the earlier added.
 * @param {LaterItem[]} items
 * @returns {LaterItem[]}
 */
export function armedInOrder(items) {
  return items
    .filter(isArmed)
    .sort((a, b) => (a.alarm.at - b.alarm.at) || (a.addedAt - b.addedAt))
}

/**
 * The position for an item put at the top: one less than the smallest, or 0.
 * @param {LaterItem[]} items
 */
export function topPosition(items) {
  if (items.length === 0) { return 0 }

  return Math.min(...items.map(item => item.position)) - 1
}

/**
 * The position between two neighbours, either of which may be missing.
 * @param {number | undefined | null} before the position above
 * @param {number | undefined | null} after the position below
 */
export function positionBetween(before, after) {
  const hasBefore = typeof before === 'number'
  const hasAfter = typeof after === 'number'

  if (hasBefore && hasAfter) { return (before + after) / 2 }
  if (hasBefore) { return before + 1 }
  if (hasAfter) { return after - 1 }
  return 0
}

/**
 * The one position to write to move a queued item to `toIndex`, or null when
 * nothing moves. `toIndex` counts places among the queued items without the
 * one moved, so 0 is the top and the count of the others is the bottom.
 * @param {LaterItem[]} items
 * @param {string} id
 * @param {number} toIndex
 * @returns {number | null}
 */
export function moveTo(items, id, toIndex) {
  const queued = queuedInOrder(items)
  const fromIndex = queued.findIndex(item => item._id === id)

  if (fromIndex === -1) { return null }

  const others = queued.filter(item => item._id !== id)
  const index = Math.max(0, Math.min(toIndex, others.length))

  if (index === fromIndex) { return null }

  return positionBetween(others[index - 1]?.position, others[index]?.position)
}

/**
 * Whether two queued neighbours have come too close to put anything between.
 * @param {LaterItem[]} items
 */
export function needsRenumbering(items) {
  const queued = queuedInOrder(items)

  for (let i = 1; i < queued.length; i++) {
    if (queued[i].position - queued[i - 1].position < RENUMBER_GAP) {
      return true
    }
  }

  return false
}

/**
 * The whole numbered positions for the queued items, in their order: the one
 * case of many writes.
 * @param {LaterItem[]} items
 * @returns {{ _id: string, position: number }[]}
 */
export function renumbered(items) {
  return queuedInOrder(items).map((item, index) => ({ _id: item._id, position: index }))
}

/**
 * The state an armed item is shown in, from the clock alone.
 * @param {number} now ms
 * @param {number} at the stated start, ms
 * @returns {'waiting' | 'checking' | 'didNotStart'}
 */
export function laterStateAt(now, at) {
  if (now < at - CHECK_BEFORE_MS) { return 'waiting' }
  if (now <= at + CHECK_AFTER_MS) { return 'checking' }
  return 'didNotStart'
}

/**
 * The record for a video, from whatever the card or the watch page had, so
 * that the page renders without asking YouTube. Neither positioned nor armed:
 * the caller sets both.
 * @param {any} video
 * @param {number} now
 * @returns {LaterItem}
 */
export function laterItemFromVideo(video, now) {
  const premiereDate = millisecondsOf(video.premiereDate) ??
    (video.premiereTimestamp != null ? Number(video.premiereTimestamp) * 1000 : null)

  /** @type {LaterItem} */
  const item = {
    _id: video.videoId,
    videoId: video.videoId,
    title: video.title ?? '',
    author: video.author ?? '',
    authorId: video.authorId ?? '',
    addedAt: now,
    position: 0,
    alarm: null,
  }

  if (typeof video.lengthSeconds === 'number' && Number.isFinite(video.lengthSeconds)) {
    item.lengthSeconds = video.lengthSeconds
  }

  if (typeof video.viewCount === 'number' && Number.isFinite(video.viewCount)) {
    item.viewCount = video.viewCount
  }

  const published = millisecondsOf(video.published)
  if (published != null) { item.published = published }

  if (video.isUpcoming === true || video.premiere === true) { item.isUpcoming = true }

  if (premiereDate != null && Number.isFinite(premiereDate)) { item.premiereDate = premiereDate }

  return item
}

/**
 * @param {unknown} value a Date, a number of ms or a date string
 * @returns {number | null}
 */
function millisecondsOf(value) {
  if (value instanceof Date) { return Number.isFinite(value.getTime()) ? value.getTime() : null }
  if (typeof value === 'number') { return Number.isFinite(value) ? value : null }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/**
 * The Later list as an export file: one item per line, in the page's order
 * (the armed first, then the queued), alarms included, as the other exports
 * are written (NDJSON, with a trailing line).
 * @param {LaterItem[]} items
 * @returns {string}
 */
export function laterToExport(items) {
  return [...armedInOrder(items), ...queuedInOrder(items)]
    .map(item => JSON.stringify(item))
    .join('\n') + '\n'
}

/**
 * The items of an export file, in its order: every line that parses into an
 * object with a video id and a title. Their positions are not kept, as an
 * import puts them above the list as a block; anything else of theirs is.
 * @param {string} text
 * @returns {LaterItem[]}
 */
export function laterFromExport(text) {
  const items = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') { continue }

    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (parsed == null || typeof parsed !== 'object' || typeof parsed.videoId !== 'string' || parsed.videoId === '' || typeof parsed.title !== 'string') {
      continue
    }

    const alarm = parsed.alarm != null && typeof parsed.alarm.at === 'number'
      ? { at: parsed.alarm.at, armedAt: typeof parsed.alarm.armedAt === 'number' ? parsed.alarm.armedAt : parsed.alarm.at }
      : null

    items.push({
      ...parsed,
      _id: parsed.videoId,
      addedAt: typeof parsed.addedAt === 'number' ? parsed.addedAt : 0,
      position: 0,
      alarm,
    })
  }

  return items
}
