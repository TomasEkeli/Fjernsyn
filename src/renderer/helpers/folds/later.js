/**
 * The Later fold: one of another machine's Later intents onto this machine's
 * Later records, keyed as the intent index keys them and changed in place.
 *
 * What comes back is the further keys the fold had to change. A move forces
 * one when the gap between two neighbours has closed and every position is
 * written again, which is the only time the fold touches a record no event
 * named. The key the event itself named is never among them, as the index
 * works that one out.
 *
 * Where a record goes is decided against the index, not against the order the
 * events happen to arrive in: a record already sitting after the key this one
 * names, put there by a newer intent, is stepped over. Two machines adding a
 * video after the same one therefore reach one list, and it is the list a
 * single batch of both events reaches. Two moves that name each other still
 * do not, which the fold cannot settle from the index as it stands.
 *
 * A record the fold creates has its id, the video's id, which is the same
 * string, and its place in the order. The title, the view count and the rest
 * of the video's own details arrive from the state files, so a video added on
 * the other machine never gets made-up details here.
 *
 * Pure, as the backup helpers are, and importable from main.
 */

import { compareStrings } from './../backup'
import { compareEvents } from './../intentLog'

/**
 * The Later intents this version knows. An event of any other type is left in
 * the segment and not counted as applied.
 * @type {readonly string[]}
 */
export const LATER_EVENTS = Object.freeze([
  'later.added',
  'later.removed',
  'later.moved',
  'later.alarmArmed',
  'later.alarmCleared',
  'later.cleared',
])

const PREFIX = 'later/'

/**
 * One Later event onto the records
 * @param {Map<string, Record<string, any>>} records this section's records by key
 * @param {import('./../intentLog').IntentEvent} event
 * @param {import('./../intentIndex').IntentIndex} index the intent that put each record where it is
 * @returns {string[] | undefined} the further keys the fold changed, when it changed any
 */
export function foldLaterEvent(records, event, index = {}) {
  switch (event.type) {
    case 'later.added':
    case 'later.moved':
      return place(records, event, records.get(event.key) ?? created(event.key), event.data.after ?? null, index)

    case 'later.removed':
      records.delete(event.key)
      return undefined

    case 'later.alarmArmed':
      return arm(records, event, index)

    case 'later.alarmCleared': {
      const record = records.get(event.key)
      if (record !== undefined) { record.alarm = null }
      return undefined
    }

    case 'later.cleared':
      for (const key of [...records.keys()]) {
        if (key.startsWith(PREFIX)) { records.delete(key) }
      }
      return undefined

    default:
      return undefined
  }
}

/**
 * The position between two neighbours, either of which may be missing, and
 * null when the two have come so close that the midpoint is one of them.
 * @param {number | null | undefined} before the position above
 * @param {number | null | undefined} after the position below
 * @returns {number | null}
 */
export function positionBetween(before, after) {
  const hasBefore = typeof before === 'number'
  const hasAfter = typeof after === 'number'

  if (!hasBefore) { return hasAfter ? after - 1 : 0 }
  if (!hasAfter) { return before + 1 }

  const between = (before + after) / 2

  return between === before || between === after ? null : between
}

/**
 * Whole numbered positions again, in the order the records are in.
 * @param {Map<string, Record<string, any>>} records
 * @returns {Record<string, any>[]} every record whose position changed
 */
export function renumber(records) {
  const changed = []

  inOrder(records).forEach(({ record }, index) => {
    if (record.position !== index) {
      record.position = index
      changed.push(record)
    }
  })

  return changed
}

// #region helpers

/**
 * A record put after the key it follows, and at the end of the list when that
 * key has gone. Running out of room between the neighbours renumbers the
 * list and looks once more, so the position written is never a neighbour's.
 *
 * @param {Map<string, Record<string, any>>} records
 * @param {import('./../intentLog').IntentEvent} event
 * @param {Record<string, any>} record
 * @param {string | null} after the key it follows, null for the front
 * @param {import('./../intentIndex').IntentIndex} index
 * @returns {string[] | undefined}
 */
function place(records, event, record, after, index) {
  const key = event.key

  let changed
  let position = positionAfter(records, event, after, index)

  if (position === null) {
    changed = renumber(records).map(moved => `${PREFIX}${moved._id}`).filter(other => other !== key)
    position = positionAfter(records, event, after, index)
  }

  record.position = position
  records.set(key, record)

  return changed !== undefined && changed.length > 0 ? changed : undefined
}

/**
 * An alarm onto its record, or onto one the fold has never seen, which goes
 * to the front as arming a video does on the machine that armed it
 * @param {Map<string, Record<string, any>>} records
 * @param {import('./../intentLog').IntentEvent} event
 * @returns {string[] | undefined}
 */
function arm(records, event, index) {
  const known = records.get(event.key)
  const record = known ?? created(event.key)

  record.alarm = event.data.alarm ?? null

  if (typeof event.data.premiereDate === 'number') {
    record.premiereDate = event.data.premiereDate
  }

  return known === undefined ? place(records, event, record, null, index) : undefined
}

/**
 * Where a record following `after` goes, with itself out of the way.
 *
 * The records already sitting after that key by a newer intent than this
 * event's are stepped over, so that two machines each adding a video after
 * the same one reach the same order whichever event they see first: the
 * newer intent always ends nearer the key both of them named.
 *
 * @param {Map<string, Record<string, any>>} records
 * @param {import('./../intentLog').IntentEvent} event
 * @param {string | null} after
 * @param {import('./../intentIndex').IntentIndex} index
 * @returns {number | null}
 */
function positionAfter(records, event, after, index) {
  const order = inOrder(records).filter(entry => entry.key !== event.key)

  const found = after === null ? -1 : order.findIndex(entry => entry.key === after)
  let at = after !== null && found === -1 ? order.length - 1 : found

  while (placedLater(index[order[at + 1]?.key], event)) { at += 1 }

  return positionBetween(order[at]?.record.position, order[at + 1]?.record.position)
}

/**
 * Whether the intent that last reached a record is newer than this event. A
 * record no intent has reached here, one that came in an archive, is older
 * than any event.
 * @param {{ at: number, by: string, seq: number } | undefined} entry
 * @param {import('./../intentLog').IntentEvent} event
 * @returns {boolean}
 */
function placedLater(entry, event) {
  if (entry === undefined) { return false }

  return compareEvents({ ...entry, seq: entry.seq ?? event.seq }, event) > 0
}

/**
 * This section's records in the order they are in, ties by key so that two
 * machines renumber the same list the same way
 * @param {Map<string, Record<string, any>>} records
 * @returns {{ key: string, record: Record<string, any> }[]}
 */
function inOrder(records) {
  return [...records]
    .filter(([key]) => key.startsWith(PREFIX))
    .map(([key, record]) => ({ key, record }))
    .sort((a, b) => (a.record.position - b.record.position) || compareStrings(a.key, b.key))
}

/**
 * A record for a video the fold has never seen. `_id` and `videoId` are the
 * same string everywhere a Later record is written, and `grabLater` drops a
 * record without the second.
 * @param {string} key
 * @returns {Record<string, any>}
 */
function created(key) {
  const id = key.slice(PREFIX.length)

  return { _id: id, videoId: id }
}

// #endregion helpers
