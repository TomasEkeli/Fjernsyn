/**
 * The state file: a machine's own state fields that have changed since the
 * archive, each record with the time this machine last changed them. This
 * module writes one, reads one back, merges the folder's into one value per
 * key, and works out what this machine has to say.
 *
 * Pure, as the backup helpers are, and importable from main. Nothing here
 * opens a file: main reads the text and hands it over.
 *
 * A state file names whole values with their own times, so a machine that
 * does not have the archive it names still reads every record in it. The
 * newest `at` across the machines wins a key, ties by the greater
 * installation id, which is the tie-break the events use.
 *
 * State never decides whether a record exists. A key the events removed is
 * gone whatever any state file says about it, and a record the archive has
 * and this machine no longer does is not a state change.
 */

import { compareStrings, sortKeys } from './backup'
import { recordKey, splitFields } from './intentFields'

/**
 * One record's state fields, and when the machine that wrote the file last
 * changed them
 * @typedef {{ at: number, fields: Record<string, any> }} StateRecord
 */

/**
 * @typedef {object} StateFile
 * @property {string} archive the hash of the archive these records are a delta against
 * @property {Record<string, StateRecord>} records by the key `recordKey` gives
 */

/**
 * A state record with the machine it came from
 * @typedef {{ at: number, by: string, fields: Record<string, any> }} MergedRecord
 */

/**
 * One machine's state file, as it went into the merge
 * @typedef {{ by: string, state: StateFile }} StateFileOf
 */

const STARTER_SOURCES_OFFERED = 'communitiesStarterSourcesOffered'
const OFFERED_KEY = `settings/${STARTER_SOURCES_OFFERED}`
const SOURCE_PREFIX = 'communitySources/'
const SHARE_PREFIX = 'communityShares/'

/**
 * @param {unknown} value
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {Record<string, any>} fields
 */
function textOf(fields) {
  return JSON.stringify(sortKeys(fields))
}

/**
 * A state file as the text to put in the folder, its keys sorted at every
 * level, so that two machines that folded the same state write the same bytes
 * @param {StateFile} state
 * @returns {string}
 */
export function writeStateFile(state) {
  return JSON.stringify(sortKeys({ archive: state.archive, records: state.records ?? {} }))
}

/**
 * A state file read back, or why the text is not one
 * @param {string} text
 * @returns {{ ok: true, state: StateFile } | { ok: false, reason: 'notJson' | 'notStateFile' }}
 */
export function readStateFile(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'notJson' }
  }

  if (!isPlainObject(parsed) || typeof parsed.archive !== 'string' || !isPlainObject(parsed.records)) {
    return { ok: false, reason: 'notStateFile' }
  }

  for (const record of Object.values(parsed.records)) {
    if (!isPlainObject(record) || typeof record.at !== 'number' || !isPlainObject(record.fields)) {
      return { ok: false, reason: 'notStateFile' }
    }
  }

  return { ok: true, state: { archive: parsed.archive, records: parsed.records } }
}

/**
 * One value per key across the machines: the newest `at` wins, ties by the
 * greater installation id, so every machine reaches the same value whichever
 * order the files arrived in
 * @param {StateFileOf[]} files
 * @returns {Record<string, MergedRecord>}
 */
export function mergeStateRecords(files) {
  /** @type {Record<string, MergedRecord>} */
  const merged = {}

  for (const { by, state } of files) {
    for (const [key, record] of Object.entries(state?.records ?? {})) {
      const held = merged[key]
      const wins = held === undefined || record.at > held.at || (record.at === held.at && compareStrings(by, held.by) > 0)

      if (wins) {
        merged[key] = { at: record.at, by, fields: record.fields }
      }
    }
  }

  return merged
}

/**
 * What this machine has to say about a section: the records whose state
 * fields differ from the archive's, as those fields alone, stamped with the
 * time this machine last changed them.
 *
 * A record the archive does not have is compared against no state fields, so
 * it is named here only once it has state fields of its own. A Later item
 * added since the archive has a title and the rest, and is named like any
 * other. One an event created with its intent fields alone is not.
 *
 * @param {string} section
 * @param {Record<string, any>[]} records this machine's, as the datastore has them
 * @param {Record<string, any>[]} archived the same section in the archive
 * @param {number} at
 * @returns {Record<string, StateRecord>}
 */
export function stateChangesSince(section, records, archived, at) {
  const before = new Map()

  for (const record of archived ?? []) {
    before.set(recordKey(section, record), textOf(splitFields(section, record).state))
  }

  /** @type {Record<string, StateRecord>} */
  const changes = {}

  for (const record of records ?? []) {
    const key = recordKey(section, record)
    const { state } = splitFields(section, record)

    if (textOf(state) === (before.get(key) ?? '{}')) { continue }

    changes[key] = { at, fields: state }
  }

  return changes
}

/**
 * The setting that lists the Communities starter sources offered already, as
 * every machine's list together. It only grows, so no starter is offered
 * again over the unfollows of a machine whose sources arrive here.
 * @param {Record<string, MergedRecord>} merged
 * @param {{ files: StateFileOf[], sections: Record<string, Record<string, any>[]> }} sides
 */
function unionStarterSourcesOffered(merged, { files }) {
  const held = merged[OFFERED_KEY]
  if (held === undefined) { return }

  const lists = files.map(({ state }) => state?.records?.[OFFERED_KEY]?.fields?.value).filter(Array.isArray)
  const value = [...new Set(lists.flat())].sort(compareStrings)

  merged[OFFERED_KEY] = { ...held, fields: { ...held.fields, value } }
}

/**
 * The shares of a source nothing follows, left out: one machine unfollowed it
 * while another changed one of its shares, and that change must not bring
 * back a share of nothing, which no unfollow would ever remove.
 * @param {Record<string, MergedRecord>} merged
 * @param {{ files: StateFileOf[], sections: Record<string, Record<string, any>[]> }} sides
 */
function dropUnfollowedShares(merged, { sections }) {
  const followed = new Set((sections?.communitySources ?? []).map(source => source._id))

  for (const key of Object.keys(merged)) {
    if (key.startsWith(SOURCE_PREFIX)) {
      followed.add(key.slice(SOURCE_PREFIX.length))
    }
  }

  for (const [key, record] of Object.entries(merged)) {
    if (key.startsWith(SHARE_PREFIX) && !followed.has(record.fields?.sourceId)) {
      delete merged[key]
    }
  }
}

/**
 * The state records the newest `at` does not settle, by the section they
 * belong to. Each takes the merged records and changes them in place, after
 * `mergeStateRecords` and before anything is written to a datastore.
 *
 * Both are fixes found the hard way in the record merge, carried over whole.
 *
 * @type {Record<string, (merged: Record<string, MergedRecord>, sides: { files: StateFileOf[], sections: Record<string, Record<string, any>[]> }) => void>}
 */
export const SETTLED_BY_RULE = Object.freeze({
  settings: unionStarterSourcesOffered,
  communityShares: dropUnfollowedShares,
})
