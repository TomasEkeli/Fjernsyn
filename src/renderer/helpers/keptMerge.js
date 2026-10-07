/**
 * The kept backup's merge: what this machine's data becomes when another
 * machine wrote the folder while this one changed things too (ADR-0024).
 *
 * Three states go in: the shared one both machines last had (the ancestor),
 * the folder's (theirs) and this machine's (ours). Each record is told apart
 * by its key and compared whole. A record only one side changed takes that
 * side's version, a removal included, so that a video watched on either
 * machine is in the history, and one removed on either is gone. A record both
 * changed differently is a conflict: the later of the two by the section's
 * time field wins, and the folder's when there is none.
 *
 * Without an ancestor (the first merge with a folder, or after a write the
 * other machine never saw) every record is new to both: the merge is a union,
 * a removal does not travel, and a conflict is the folder's, except in the
 * history, where the later watch wins.
 *
 * Settings are never removed, as a restore never removes one, and never
 * include the machine-bound ones, which the caller has already left out of
 * both sides.
 *
 * Pure, as the backup format is, and importable from main.
 */

import { BACKUP_SECTIONS, sortKeys } from './backup'

/** @typedef {import('./keptBackup').Sections} Sections */
/** @typedef {import('./keptBackup').Changes} Changes */

/**
 * The field that says when a record last changed, where a section has one
 * @type {Partial<Record<string, string>>}
 */
const TIME_FIELDS = {
  history: 'timeWatched',
  playlists: 'lastUpdatedAt',
  searchHistory: 'lastUpdatedAt',
  aiVerdicts: 'checkedAt',
}

/**
 * The key a record is told apart by: the video in the history, as each
 * machine gives a video it watched an `_id` of its own; the `_id` elsewhere
 * @param {string} section
 * @returns {(record: Record<string, any>) => string}
 */
function keyOf(section) {
  return section === 'history'
    ? record => typeof record.videoId === 'string' && record.videoId !== '' ? `v:${record.videoId}` : `i:${record._id}`
    : record => String(record._id)
}

/**
 * @typedef {{ record: Record<string, any>, text: string }} Entry
 */

/**
 * @param {string} section
 * @param {Record<string, any>[] | undefined} records
 * @returns {Map<string, Entry>}
 */
function entries(section, records) {
  const key = keyOf(section)
  const map = new Map()

  for (const record of records ?? []) {
    map.set(key(record), { record, text: JSON.stringify(sortKeys(record)) })
  }

  return map
}

/**
 * @param {string} section
 * @param {Entry} theirs
 * @param {Entry} ours
 * @param {boolean} timed whether the time field may decide
 */
function laterOf(section, theirs, ours, timed) {
  const field = timed ? TIME_FIELDS[section] : undefined
  if (field !== undefined) {
    const theirTime = theirs.record[field]
    const ourTime = ours.record[field]

    if (typeof theirTime === 'number' && typeof ourTime === 'number' && ourTime > theirTime) {
      return ours
    }
  }

  return theirs
}

/**
 * @typedef {object} MergeResult
 * @property {Sections} merged every section, merged
 * @property {Changes} toApply what to put and remove in this machine's datastores, by `_id`, to make ours the merged state; a section with nothing to do is absent
 * @property {number} conflicts records both sides changed differently
 */

/**
 * @param {object} states
 * @param {Sections | null} states.ancestor the shared state both last had; null when it is not known
 * @param {Sections} states.theirs the folder's
 * @param {Sections} states.ours this machine's
 * @returns {MergeResult}
 */
export function mergeSections({ ancestor, theirs, ours }) {
  const merged = {}
  const toApply = {}
  let conflicts = 0

  for (const section of BACKUP_SECTIONS) {
    if (theirs[section] === undefined && ours[section] === undefined) { continue }

    const base = entries(section, ancestor?.[section])
    const their = entries(section, theirs[section])
    const our = entries(section, ours[section])

    const result = []
    const put = []
    const remove = []

    for (const key of new Set([...base.keys(), ...their.keys(), ...our.keys()])) {
      const a = base.get(key)
      const t = their.get(key)
      const o = our.get(key)

      /** @type {Entry | undefined} */
      let chosen

      if (t?.text === o?.text) {
        chosen = t
      } else if (ancestor !== null && t?.text === a?.text) {
        chosen = o
      } else if (ancestor !== null && o?.text === a?.text) {
        chosen = t
      } else {
        // Both changed it, or there is no ancestor to tell which did: what
        // one side has and the other lacks is kept, as a removal cannot be
        // told from an addition the other side never saw
        if (t !== undefined && o !== undefined) {
          conflicts++
        }
        chosen = t === undefined ? o : o === undefined ? t : laterOf(section, t, o, ancestor !== null || section === 'history')
      }

      // A setting is upserted, never removed
      if (chosen === undefined && section === 'settings') {
        chosen = o
      }

      if (chosen !== undefined) {
        result.push(chosen.record)
      }

      if (chosen?.text === o?.text) { continue }

      if (o !== undefined && (chosen === undefined || chosen.record._id !== o.record._id)) {
        remove.push(o.record._id)
      }

      if (chosen !== undefined) {
        put.push(chosen.record)
      }
    }

    merged[section] = result

    if (put.length > 0 || remove.length > 0) {
      toApply[section] = { put, remove }
    }
  }

  return { merged, toApply, conflicts }
}
