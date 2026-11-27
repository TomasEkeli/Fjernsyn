/**
 * The intent index: for each key, the last intent applied to it, as the time
 * it happened, the machine that made it and that machine's own counter. It is
 * what makes two machines reach the same records whichever order the events
 * arrive in. An event older than its key's entry is seen and changes nothing,
 * so a late unsubscribe still beats a subscribe made before it and still
 * loses to one made after it.
 *
 * A section has a floor of its own, under `<section>/*`, written by an event
 * that names a whole section, such as a clear of Later. An event must beat
 * both its key's entry and its section's floor, so an addition made before a
 * clear does not undo the clear by arriving after it. A whole-section event
 * is also held off every key it does not beat, so a record added a second
 * after a clear survives the clear arriving late. Both halves are needed, one
 * for each order of arrival.
 *
 * Pure, as the backup helpers are, and importable from main. Folding a
 * section's events onto its records is the section's own work. This module
 * decides which events reach the fold, and which keys changed when they did.
 */

import { compareStrings, sortKeys } from './backup'
import { compareEvents } from './intentLog'

/**
 * The last intent applied to each key, with a section's floor under
 * `<section>/*`
 * @typedef {Record<string, { at: number, by: string, seq: number }>} IntentIndex
 */

const WHOLE_SECTION = '*'

/**
 * Whether an event is newer than what was applied to a key before, in the one
 * order every machine puts events in. The counter settles two intents on one
 * key in the same millisecond from one machine, which the time and the
 * installation id alone leave tied.
 * @param {import('./intentLog').IntentEvent} event
 * @param {{ at: number, by: string, seq: number } | undefined} entry
 * @returns {boolean}
 */
export function beats(event, entry) {
  if (entry === undefined) { return true }

  // An entry written before the index kept `seq` cannot be told from an event
  // at the same time from the same machine, so it keeps the tie: skipping one
  // intent costs less than replaying a move over a list
  return compareEvents(event, { ...entry, seq: entry.seq ?? event.seq }) > 0
}

/**
 * Another machine's events onto this machine's records.
 *
 * The records are changed in place, by the section's own fold. What comes
 * back is what to write: the changed records of the keys the events named,
 * the keys of those that have gone, and the index to keep. A record no event
 * named is in neither list, however far the fold moved it, so a gap in the
 * vocabulary costs one intent its journey and never a record.
 *
 * A fold may return the keys of the records it had to change beyond the one
 * the event named, which a Later move forces when it renumbers its
 * neighbours. Those are written too. A fold that returns nothing is read as
 * having changed the named key alone. A returned key is only ever written,
 * never removed, because whether a record is there at all is an intent and
 * belongs to a key an event named.
 *
 * The fold is given the index as it stands, so that a fold which places one
 * record against another can tell which intent put each of them where it is.
 * A fold that does not need it takes two arguments and behaves as it did.
 *
 * Every event this version knows comes back under `applied`, whether it beat
 * the index or not, because an event that lost has still been seen. One whose
 * type this version does not know comes back under `skipped` and is not
 * counted, so an older machine cannot archive away a newer one's intent.
 *
 * @param {object} options
 * @param {Map<string, Record<string, any>>} options.records this section's records by key, changed in place
 * @param {IntentIndex} options.index what was applied before, left as it was
 * @param {import('./intentLog').IntentEvent[]} options.events in any order
 * @param {(records: Map<string, Record<string, any>>, event: import('./intentLog').IntentEvent, index: IntentIndex) => string[] | void} options.foldEvent the section's own fold, returning any further keys it changed
 * @param {(type: string) => boolean} options.knows whether this version understands a type
 * @returns {{ put: Record<string, any>[], remove: string[], index: IntentIndex, applied: import('./intentLog').IntentEvent[], skipped: import('./intentLog').IntentEvent[] }}
 */
export function applyIntents({ records, index, events, foldEvent, knows }) {
  const applied = []
  const skipped = []

  for (const event of [...events].sort(compareEvents)) {
    (knows(event.type) ? applied : skipped).push(event)
  }

  const before = new Map()
  for (const event of applied) {
    for (const key of keysNamed(event.key, records)) {
      if (!before.has(key)) { before.set(key, print(records.get(key))) }
    }
  }

  const next = { ...index }
  const alsoChanged = new Set()

  for (const event of applied) {
    if (!beats(event, next[event.key]) || !beats(event, next[sectionFloor(event.key)])) { continue }

    for (const key of foldOne(records, event, next, foldEvent)) { alsoChanged.add(key) }

    next[event.key] = { at: event.at, by: event.by, seq: event.seq }
  }

  const put = []
  const remove = []

  for (const key of [...new Set([...before.keys(), ...alsoChanged])].sort(compareStrings)) {
    const record = records.get(key)

    if (record === undefined) {
      if (before.get(key) !== undefined) { remove.push(key) }
    } else if (!before.has(key) || print(record) !== before.get(key)) {
      put.push(record)
    }
  }

  return { put, remove, index: next, applied, skipped }
}

// #region helpers

/**
 * One event through the section's fold, with the records a whole-section
 * event does not beat taken out of its way and put back afterwards. A
 * whole-section event applies key by key, and at each key it must still beat
 * what was applied there, so a clear that arrives late leaves alone a record
 * added after the clear happened. A record put back was decided by a newer
 * intent than the event being folded, so it wins whatever the fold did.
 *
 * @param {Map<string, Record<string, any>>} records
 * @param {import('./intentLog').IntentEvent} event
 * @param {IntentIndex} index
 * @param {(records: Map<string, Record<string, any>>, event: import('./intentLog').IntentEvent, index: IntentIndex) => string[] | void} foldEvent
 * @returns {string[]} the further keys the fold changed
 */
function foldOne(records, event, index, foldEvent) {
  const heldOut = new Map()

  if (event.key === sectionFloor(event.key)) {
    for (const key of keysNamed(event.key, records)) {
      if (!beats(event, index[key])) {
        heldOut.set(key, records.get(key))
        records.delete(key)
      }
    }
  }

  const changed = foldEvent(records, event, index)

  for (const [key, record] of heldOut) { records.set(key, record) }

  return Array.isArray(changed) ? changed : []
}

/**
 * The keys an event's key names: itself, or every key of its section when it
 * names the section whole
 * @param {string} key
 * @param {Map<string, Record<string, any>>} records
 * @returns {string[]}
 */
function keysNamed(key, records) {
  if (key !== sectionFloor(key)) { return [key] }

  const section = sectionOf(key)

  return [...records.keys()].filter(other => sectionOf(other) === section)
}

/**
 * @param {string} key
 * @returns {string}
 */
function sectionFloor(key) {
  return `${sectionOf(key)}/${WHOLE_SECTION}`
}

/**
 * @param {string} key
 * @returns {string}
 */
function sectionOf(key) {
  const split = key.indexOf('/')

  return split === -1 ? key : key.slice(0, split)
}

/**
 * A record as text that is the same for the same fields in any order, so that
 * a fold which changes a record in place can still be told from one that left
 * it alone
 * @param {Record<string, any> | undefined} record
 * @returns {string | undefined}
 */
function print(record) {
  return record === undefined ? undefined : JSON.stringify(sortKeys(record))
}

// #endregion helpers
