/**
 * Recording an intent at the handler seam.
 *
 * A handler method does not say what the write meant: `later.upsert` is an
 * addition, a re-arm and a restore alike. So nothing here maps a method to an
 * event. Each wrapped method reads the record the write will change, calls
 * the original, reads it again, and asks the section what moved. One rule for
 * every method, upstream's next one included.
 *
 * The write goes through whatever the diff says. This wraps and never gates.
 *
 * A field the partition does not know is neither half of an intent: it makes
 * no event and travels in none, so the foreign fields an import or a restore
 * leaves on a record (`authorThumbnail`, `peertubeCategory`) cannot invent one.
 *
 * Reading costs two lookups in a datastore that is already in memory.
 */

import { compareStrings } from '../../renderer/helpers/backup'
import { isEventedSection, recordKey, splitFields } from '../../renderer/helpers/intentFields'

/**
 * What a change to one of a section's records is, by section. A section with
 * no reader here records nothing, whatever the partition says.
 */
const SECTION_INTENTS = Object.freeze({ later: laterIntents })

/**
 * Which of a section's records hold their place by their position. An armed
 * Later record is ordered by its stated time instead (`helpers/later.js`),
 * and a renumber leaves its position where it was, so counting it in the
 * order reads the queued records moving past it as moves.
 */
const SECTION_PLACED = Object.freeze({ later: record => record.alarm == null })

/** A class's own properties that are not its methods */
const NOT_METHODS = Object.freeze(['length', 'name', 'prototype'])

/**
 * @typedef {object} Intent
 * @property {string} type
 * @property {string} key
 * @property {Record<string, any>} data
 */

/**
 * Wraps the methods of the handler classes of every evented section, as
 * `watchDatastores` wraps the datastores, so that each write records the
 * intent it was.
 *
 * @param {Record<string, any>} handlers the handler classes, by section name
 * @param {object} deps
 * @param {(section: string, id?: string) => Promise<any>} deps.read one record by id, or the section's records when no id is given
 * @param {(intent: Intent) => void} deps.onIntent once for each intent the write was, in the order they are to be applied, and not at all for a write that moved no intent field
 */
export function watchIntents(handlers, { read, onIntent }) {
  for (const [section, handler] of Object.entries(handlers)) {
    if (!isEventedSection(section) || SECTION_INTENTS[section] === undefined) { continue }

    for (const name of methodsOf(handler)) {
      const original = handler[name]

      handler[name] = function (...args) {
        return recorded({ section, original, self: this, args, read, onIntent })
      }
    }
  }
}

/**
 * The intents a change to one Later record is, in the order they are to be
 * applied. Usually one, none for a write that was no intent at all.
 *
 * A write that both places the record and arms it is two: the placement, then
 * the alarm. `later.alarmArmed` carries no place, and the fold puts a record
 * it has never seen at the front, so an armed video added in the middle of a
 * batch would land first on the other machine without the placement before
 * it. `addManyToLater` keeps each item's alarm, so a takeover or an import is
 * a batch of exactly those.
 *
 * An alarm is an intent only when `armedAt` moved. The scheduler follows a
 * premiere date that moved by writing `alarm.at` and leaving `armedAt` alone,
 * and an event for that would re-arm on the other machine what was disarmed
 * there.
 *
 * @param {Record<string, any> | null} before
 * @param {Record<string, any> | null} after
 * @param {{ key: string, record: Record<string, any> }[]} order the section as the write leaves it, in the order it is in
 * @returns {Intent[]}
 */
export function laterIntents(before, after, order) {
  if (after === null) {
    return before === null ? [] : [{ type: 'later.removed', key: recordKey('later', before), data: {} }]
  }

  const key = recordKey('later', after)
  const intents = []

  if (before === null) {
    intents.push({ type: 'later.added', key, data: { after: follows(order, key) } })
  } else if (reordered(order, key, before.position)) {
    intents.push({ type: 'later.moved', key, data: { after: follows(order, key) } })
  }

  if (armedAt(before) !== armedAt(after)) {
    intents.push(after.alarm == null
      ? { type: 'later.alarmCleared', key, data: {} }
      : { type: 'later.alarmArmed', key, data: armedData(after) })
  }

  return intents
}

// #region helpers

/**
 * One write, with the records read either side of it. A write that threw is
 * not asked: there is no intent in a change that did not happen.
 * @returns {Promise<any>} what the original returned
 */
async function recorded({ section, original, self, args, read, onIntent }) {
  const id = idOf(args[0])
  const before = id === null ? await read(section) : await read(section, id)

  const result = await original.apply(self, args)

  const records = await read(section)

  if (id === null) {
    for (const intent of wholeSection(section, before, records)) {
      onIntent(intent)
    }

    return result
  }

  const after = records.find(record => record._id === id) ?? null

  if (intentMoved(section, before, after)) {
    for (const intent of SECTION_INTENTS[section](before, after, inOrder(section, records))) {
      onIntent(intent)
    }
  }

  return result
}

/**
 * The intents a write that named no record is. Emptying the section is one.
 * Otherwise it is a move for each record that now follows a different key,
 * in the order the section is left in, so that applying them in that order
 * reaches the same list, and only among the records that hold their place by
 * their position. A renumber writes every position and leaves every neighbour
 * where it was, so it is none of them.
 * @param {string} section
 * @param {Record<string, any>[]} before
 * @param {Record<string, any>[]} after
 * @returns {Intent[]}
 */
function wholeSection(section, before, after) {
  if (after.length === 0) {
    return before.length === 0 ? [] : [{ type: `${section}.cleared`, key: `${section}/*`, data: {} }]
  }

  const placed = SECTION_PLACED[section]
  const was = inOrder(section, placed === undefined ? before : before.filter(placed))
  const now = inOrder(section, placed === undefined ? after : after.filter(placed))

  return now
    .filter(entry => follows(now, entry.key) !== follows(was, entry.key))
    .map(entry => ({ type: `${section}.moved`, key: entry.key, data: { after: follows(now, entry.key) } }))
}

/**
 * The methods of a handler class. A class's statics are not enumerable, so
 * `getOwnPropertyNames` is what finds them.
 * @param {Record<string, any>} handler
 * @returns {string[]}
 */
function methodsOf(handler) {
  return Object.getOwnPropertyNames(handler)
    .filter(name => !NOT_METHODS.includes(name) && typeof handler[name] === 'function')
}

/**
 * The record a write names, from its first argument: an id, or the record
 * itself. A write that names none is the whole section's.
 * @param {any} argument
 * @returns {string | null}
 */
function idOf(argument) {
  if (typeof argument === 'string' && argument !== '') { return argument }

  const id = argument?._id

  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Whether any of the record's intent fields moved. Whether the record is
 * there at all is the first of them.
 * @param {string} section
 * @param {Record<string, any> | null} before
 * @param {Record<string, any> | null} after
 * @returns {boolean}
 */
function intentMoved(section, before, after) {
  if (before === null || after === null) { return before !== after }

  const was = splitFields(section, before).intent
  const now = splitFields(section, after).intent

  return [...new Set([...Object.keys(was), ...Object.keys(now)])]
    .some(field => JSON.stringify(was[field] ?? null) !== JSON.stringify(now[field] ?? null))
}

/**
 * A section's records in the order they are in, ties by key, as the fold
 * orders them
 * @param {string} section
 * @param {Record<string, any>[]} records
 * @returns {{ key: string, record: Record<string, any> }[]}
 */
function inOrder(section, records) {
  return records
    .map(record => ({ key: recordKey(section, record), record }))
    .sort((a, b) => (a.record.position - b.record.position) || compareStrings(a.key, b.key))
}

/** @param {Record<string, any> | null} record */
function armedAt(record) {
  const at = record?.alarm?.armedAt

  return typeof at === 'number' ? at : null
}

/**
 * The alarm, and the stated time with it where the record has one, so that an
 * armed record is coherent on the other machine before its state file lands
 * @param {Record<string, any>} after
 */
function armedData(after) {
  return typeof after.premiereDate === 'number'
    ? { alarm: after.alarm, premiereDate: after.premiereDate }
    : { alarm: after.alarm }
}

/**
 * The key a record follows, null for the front of the list
 * @param {{ key: string, record: Record<string, any> }[]} order
 * @param {string} key
 * @returns {string | null}
 */
function follows(order, key) {
  const at = order.findIndex(entry => entry.key === key)

  return at > 0 ? order[at - 1].key : null
}

/**
 * Whether the write left the list in another order. A renumber writes every
 * position and leaves the order as it was, so it is no intent. A move puts
 * one key somewhere else, and this sees it.
 *
 * Only the one record's position moved, so the order before the write is the
 * order after it with that position put back.
 *
 * @param {{ key: string, record: Record<string, any> }[]} order
 * @param {string} key
 * @param {number} position as it was before the write
 * @returns {boolean}
 */
function reordered(order, key, position) {
  const was = order
    .map(entry => entry.key === key ? { key, record: { ...entry.record, position } } : entry)
    .sort((a, b) => (a.record.position - b.record.position) || compareStrings(a.key, b.key))

  return order.some((entry, at) => entry.key !== was[at].key)
}

// #endregion helpers
