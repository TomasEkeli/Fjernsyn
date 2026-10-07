/**
 * The kept backup: a base, which is a backup as Export backup writes one, and
 * a sync file holding every change since that base. This module turns two
 * states into the changes between them and back, and writes and reads the
 * sync file, checked whole.
 *
 * Pure, as the backup format is, and importable from main: it imports only
 * the backup format. The keeper in main hashes, gzips and touches the folder;
 * here a hash is only its hex digits.
 *
 * Records are matched by `_id` in every section, history included: the
 * datastore gives every record one, and it is what a removal can name. A
 * record that differs in any way is put whole, so that applying changes needs
 * no knowledge of any section's fields.
 *
 * The sync file's text is stable, as a backup's is: the same changes give the
 * same bytes, so that a sync tool carries nothing when nothing changed, and a
 * hash of the text tells one machine's write from another's.
 */

import { BACKUP_SECTIONS, compareStrings, orderSections, sortKeys } from './backup'

export const SYNC_FORMAT = 'fjernsyn-sync'

/**
 * Raised only when a reader of the old version would misread the new file. A
 * section added later does not need it, since unknown sections are ignored.
 */
export const SYNC_FORMAT_VERSION = 1

/** The sync file's name in the backup folder, the same on every machine */
export const SYNC_FILE_NAME = 'fjernsyn-sync.json'

/**
 * The length of sync file text past which the keeper writes a new base. The
 * sync file is uploaded on every write, the base only on a rebase, so the
 * changes are kept small and the base rarely written.
 */
export const REBASE_THRESHOLD = 2 * 1024 * 1024

/**
 * How many earlier sync files a sync file names as the ones its state builds
 * on, newest first, each by the first 16 hex digits of its hash. A machine
 * whose last seen file is among them knows that file's state is shared by
 * both, and merges against it.
 */
export const LINEAGE_LENGTH = 100

const LINEAGE_ENTRY = /^[0-9a-f]{16}$/

/**
 * A sync file as its lineage names it
 * @param {string} sha256Hex the hash of its text
 */
export function lineageEntry(sha256Hex) {
  return sha256Hex.slice(0, 16)
}

/** @typedef {import('./backup').BackupSection} BackupSection */

/** @typedef {Partial<Record<BackupSection, Record<string, any>[]>>} Sections */

/**
 * A section's changes since the base: each new or changed record whole, and
 * the `_id`s gone
 * @typedef {{ put: Record<string, any>[], remove: string[] }} SectionChanges
 */

/**
 * Only the sections that changed: a section absent is the base's as it is
 * @typedef {Partial<Record<BackupSection, SectionChanges>>} Changes
 */

/**
 * The base a sync file builds on
 * @typedef {object} BaseReference
 * @property {string} file the base's file name in the backup folder
 * @property {string} sha256 the hex SHA-256 of the base's unpacked text
 */

/**
 * @typedef {object} SyncHeader
 * @property {number} formatVersion
 * @property {string | null} appVersion
 * @property {string | null} installationId
 * @property {string | null} machineName the host name of the computer that wrote it; null when the file does not say
 * @property {string[]} lineage the sync files this one's state builds on, newest first, by the first 16 hex digits of their hashes; empty when the file does not say
 */

/**
 * @typedef {{ ok: false, reason: 'notJson' | 'notSyncFile' } |
 *   { ok: false, reason: 'newerVersion', formatVersion: number } |
 *   { ok: false, reason: 'malformedChanges', section: BackupSection }} SyncRefusal
 */

/**
 * @typedef {object} SyncContents
 * @property {true} ok
 * @property {SyncHeader} header
 * @property {BaseReference} base
 * @property {Changes} changes the known sections' changes, each with both lists; a section this version does not know is dropped
 */

const SHA256_HEX = /^[0-9a-f]{64}$/
const BASE_FILE_NAME = /^base-[0-9a-f]{16}\.json\.gz$/

/**
 * A base's file name: named by its hash, so that two bases never share a
 * name and a sync file names exactly the one it builds on
 * @param {string} sha256Hex the hex SHA-256 of the base's unpacked text
 * @returns {string} `base-<first 16 hex digits>.json.gz`
 */
export function baseFileName(sha256Hex) {
  // A name the reader would refuse must never be written
  if (!SHA256_HEX.test(sha256Hex)) {
    throw new TypeError('A base is named by a SHA-256 in 64 lower case hex digits')
  }

  return `base-${sha256Hex.slice(0, 16)}.json.gz`
}

/**
 * Whether a file name in the backup folder is a base's
 * @param {string} name
 */
export function isBaseFileName(name) {
  return BASE_FILE_NAME.test(name)
}

/**
 * The content: the sections in the stable order, without a header, as text.
 * Two states are the same when their content text is.
 * @param {Sections} sections
 * @returns {string}
 */
export function contentText(sections) {
  return JSON.stringify(orderSections(sections))
}

/**
 * The changes from a base's sections to the current ones. A section present
 * in only one of the two counts as empty in the other; a section with no
 * difference is absent.
 *
 * @param {Sections} baseSections
 * @param {Sections} currentSections
 * @returns {Changes}
 */
export function computeChanges(baseSections, currentSections) {
  const changes = {}

  for (const section of BACKUP_SECTIONS) {
    const base = byId(section, baseSections[section] ?? [])
    const current = byId(section, currentSections[section] ?? [])

    const put = []
    for (const [id, record] of current) {
      const before = base.get(id)
      // Key-sorted, so that a record whose keys merely came back in another
      // order is not taken for a changed one
      if (before === undefined || recordText(before) !== recordText(record)) {
        put.push(record)
      }
    }

    const remove = [...base.keys()].filter(id => !current.has(id))

    if (put.length > 0 || remove.length > 0) {
      changes[section] = { put, remove }
    }
  }

  return changes
}

/**
 * The sections given a base's sections and the changes since: every section
 * of the base, with its removed ids taken out and its put records in place of
 * the ones with the same `_id`, or beside them when new. Neither input is
 * changed.
 *
 * @param {Sections} baseSections
 * @param {Changes} changes
 * @returns {Sections}
 */
export function applyChanges(baseSections, changes) {
  const sections = {}

  for (const [section, records] of Object.entries(baseSections)) {
    if (Array.isArray(records)) { sections[section] = [...records] }
  }

  for (const section of BACKUP_SECTIONS) {
    const sectionChanges = changes[section]
    if (sectionChanges === undefined) { continue }

    const removed = new Set(sectionChanges.remove ?? [])
    const put = new Map((sectionChanges.put ?? []).map(record => [record._id, record]))

    const records = []
    for (const record of sections[section] ?? []) {
      if (removed.has(record._id)) { continue }

      if (put.has(record._id)) {
        records.push(put.get(record._id))
        put.delete(record._id)
      } else {
        records.push(record)
      }
    }

    records.push(...put.values())
    sections[section] = records
  }

  return sections
}

/**
 * A sync file's text, in the stable order: the sections in the backup's fixed
 * order, put before remove, the put records in the backup's stable order and
 * the removed ids sorted. A section whose changes are both empty is not
 * written, so that it cannot make two files of the same changes differ.
 *
 * @param {object} syncFile
 * @param {string} syncFile.appVersion
 * @param {string} syncFile.installationId
 * @param {string | null} [syncFile.machineName] the host name of the computer writing it
 * @param {string[]} [syncFile.lineage] the sync files its state builds on, newest first
 * @param {BaseReference} syncFile.base
 * @param {Changes} syncFile.changes
 * @returns {string}
 */
export function writeSyncFile({ appVersion, installationId, machineName = null, lineage = [], base: { file, sha256 }, changes }) {
  const ordered = {}

  for (const section of BACKUP_SECTIONS) {
    const sectionChanges = changes[section]
    if (sectionChanges === undefined) { continue }

    const put = sectionChanges.put ?? []
    const remove = sectionChanges.remove ?? []
    if (put.length === 0 && remove.length === 0) { continue }

    ordered[section] = {
      put: orderSections({ [section]: put })[section],
      remove: [...remove].sort(compareStrings),
    }
  }

  const document = {
    format: SYNC_FORMAT,
    formatVersion: SYNC_FORMAT_VERSION,
    appVersion,
    installationId,
    machineName,
    lineage: lineage.slice(0, LINEAGE_LENGTH),
    base: { file, sha256 },
    changes: ordered,
  }

  return JSON.stringify(document, null, 2) + '\n'
}

/**
 * A sync file's text, read and checked whole: either a refusal with its
 * reason, or the header, the base it builds on and the changes.
 *
 * The records are only checked to have an `_id`: whether each one can be
 * stored is decided after applying, when the result is read as a backup is.
 *
 * @param {string} text
 * @returns {SyncRefusal | SyncContents}
 */
export function readSyncFile(text) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'notJson' }
  }

  if (!isPlainObject(document) || document.format !== SYNC_FORMAT || !Number.isInteger(document.formatVersion) ||
    document.formatVersion < 1) {
    return { ok: false, reason: 'notSyncFile' }
  }

  // Before the rest, as a newer version may have changed what the rest is
  if (document.formatVersion > SYNC_FORMAT_VERSION) {
    return { ok: false, reason: 'newerVersion', formatVersion: document.formatVersion }
  }

  const { base } = document
  if (!isPlainObject(base) || typeof base.sha256 !== 'string' || !SHA256_HEX.test(base.sha256) ||
    typeof base.file !== 'string' || base.file !== baseFileName(base.sha256) || !isPlainObject(document.changes)) {
    return { ok: false, reason: 'notSyncFile' }
  }

  const changes = {}

  for (const section of BACKUP_SECTIONS) {
    if (!Object.hasOwn(document.changes, section)) { continue }

    const sectionChanges = readSectionChanges(document.changes[section])
    if (sectionChanges === null) {
      return { ok: false, reason: 'malformedChanges', section }
    }

    changes[section] = sectionChanges
  }

  return {
    ok: true,
    header: {
      formatVersion: document.formatVersion,
      appVersion: typeof document.appVersion === 'string' ? document.appVersion : null,
      installationId: typeof document.installationId === 'string' ? document.installationId : null,
      machineName: typeof document.machineName === 'string' && document.machineName !== '' ? document.machineName : null,
      // Written by this version, never needed: a file without it is merged as
      // one whose shared state is not known
      lineage: Array.isArray(document.lineage) ? document.lineage.filter(entry => typeof entry === 'string' && LINEAGE_ENTRY.test(entry)) : [],
    },
    base: { file: base.file, sha256: base.sha256 },
    changes,
  }
}

/**
 * Whether the sync file has grown past the point where a new base is due
 * @param {string} syncText
 */
export function rebaseNeeded(syncText) {
  return syncText.length > REBASE_THRESHOLD
}

// #region helpers

/**
 * A section's records by `_id`
 * @param {BackupSection} section
 * @param {Record<string, any>[]} records
 * @returns {Map<string, Record<string, any>>}
 */
function byId(section, records) {
  const map = new Map()

  for (const record of records) {
    // The datastore gives every record an _id; one without could be neither
    // put nor removed, and would silently go missing from the other machine
    if (!isPlainObject(record) || typeof record._id !== 'string' || record._id === '') {
      throw new TypeError(`A record in ${section} has no _id`)
    }

    map.set(record._id, record)
  }

  return map
}

/**
 * @param {Record<string, any>} record
 * @returns {string}
 */
function recordText(record) {
  return JSON.stringify(sortKeys(record))
}

/**
 * One section's changes checked: both lists, or null when either is not what
 * it must be
 * @param {unknown} input
 * @returns {SectionChanges | null}
 */
function readSectionChanges(input) {
  if (!isPlainObject(input)) { return null }

  // Absent is empty; null is not a list, and refused as any other non-list is
  const put = input.put === undefined ? [] : input.put
  const remove = input.remove === undefined ? [] : input.remove

  if (!Array.isArray(put) || !put.every(record => isPlainObject(record) && typeof record._id === 'string' && record._id !== '')) {
    return null
  }

  if (!Array.isArray(remove) || !remove.every(id => typeof id === 'string')) {
    return null
  }

  return { put, remove }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// #endregion helpers
