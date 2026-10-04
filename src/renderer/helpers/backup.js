/**
 * The backup file: every section of the app's data in one JSON document, and
 * the reading of one back, checked whole before anything is written.
 *
 * Pure: no store, no IPC, no Electron, so that it is tested on its own. What
 * goes into a backup, and what a restore does with what comes out, are the
 * Backup group's (components/BackupSettings) and main's (main/backup).
 *
 * The text is stable: exporting unchanged data twice gives the same bytes. The
 * sections come in a fixed order, the records within a section are sorted by
 * their key, and the keys of every object are sorted at every level, while the
 * arrays inside a record (a playlist's videos, a profile's subscriptions) keep
 * their order. There is no time in the header, as it would make every export
 * differ; the file name has the date.
 *
 * The per-record checks mirror the required keys of the section imports in
 * DataSettings.vue, written here rather than moved out of upstream's file. A
 * record that passes is kept whole, unknown keys included, so that a field
 * added by a newer version survives a round trip through an older one.
 */

import { splitImportedPlatformFields } from '../platform/records'

export const BACKUP_FORMAT = 'fjernsyn-backup'

/**
 * Raised only when a reader of the old version would misread the new file. A
 * section added later does not need it, since unknown sections are ignored.
 */
export const BACKUP_FORMAT_VERSION = 1

/**
 * The sections, in the order they are written
 * @type {readonly ['profiles', 'history', 'playlists', 'later', 'searchHistory', 'settings', 'channels', 'aiVerdicts']}
 */
export const BACKUP_SECTIONS = Object.freeze(['profiles', 'history', 'playlists', 'later', 'searchHistory', 'settings', 'channels', 'aiVerdicts'])

/** @typedef {typeof BACKUP_SECTIONS[number]} BackupSection */

/**
 * Why a record was left out of a restore
 * @typedef {'missingFields' | 'invalidPeerTube' | 'duplicate' | 'unknownSetting' | 'machineBound' | 'playlistVideos'} LeftOutReason
 */

/**
 * @typedef {object} SectionCount
 * @property {number} kept the records the restore writes
 * @property {Partial<Record<LeftOutReason, number>>} leftOut by reason; `playlistVideos` counts videos inside kept playlists, every other reason whole records
 */

/**
 * @typedef {object} BackupHeader
 * @property {number} formatVersion
 * @property {string | null} appVersion
 * @property {string | null} installationId
 */

/**
 * @typedef {{ ok: false, reason: 'notJson' | 'notBackup' } |
 *   { ok: false, reason: 'newerVersion', formatVersion: number } |
 *   { ok: false, reason: 'sectionNotArray', section: BackupSection }} BackupRefusal
 */

/**
 * @typedef {object} BackupContents
 * @property {true} ok
 * @property {BackupHeader} header
 * @property {Partial<Record<BackupSection, Record<string, any>[]>>} sections the sections to replace, each with its good records; a section the backup does not hold is absent
 * @property {Partial<Record<BackupSection, SectionCount>>} counts for each section in `sections`
 * @property {string[]} unknownSections the names of sections this version does not know, which are ignored
 */

/**
 * The name the Export backup suggests
 * @param {string} date `YYYY-MM-DD`
 */
export function backupFileName(date) {
  return `fjernsyn-backup-${date}.json`
}

/**
 * A backup's text, in the stable order.
 *
 * @param {object} backup
 * @param {string} backup.appVersion
 * @param {string} backup.installationId
 * @param {Partial<Record<BackupSection, Record<string, any>[]>>} backup.sections each section's records, as the datastore holds them; a section left out is not written
 * @returns {string}
 */
export function writeBackup({ appVersion, installationId, sections }) {
  const ordered = {}

  for (const section of BACKUP_SECTIONS) {
    const records = sections[section]
    if (!Array.isArray(records)) { continue }

    const key = recordKey(section)
    ordered[section] = records
      .map(sortKeys)
      .sort((a, b) => compareStrings(key(a), key(b)) || compareStrings(String(a._id ?? ''), String(b._id ?? '')))
  }

  const document = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion,
    installationId,
    sections: ordered,
  }

  return JSON.stringify(document, null, 2) + '\n'
}

/**
 * A backup's text, read and checked whole: either a refusal with its reason,
 * or what a restore would write and what it would leave out.
 *
 * @param {string} text
 * @param {object} settings what is needed to judge the settings section
 * @param {Iterable<string>} settings.knownSettings the names of every setting this app knows
 * @param {Iterable<string>} settings.machineBoundSettings the settings that belong to the machine, never in a backup
 * @returns {BackupRefusal | BackupContents}
 */
export function readBackup(text, { knownSettings, machineBoundSettings }) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'notJson' }
  }

  if (!isPlainObject(document) || document.format !== BACKUP_FORMAT || !Number.isInteger(document.formatVersion) ||
    document.formatVersion < 1 || !isPlainObject(document.sections)) {
    return { ok: false, reason: 'notBackup' }
  }

  if (document.formatVersion > BACKUP_FORMAT_VERSION) {
    return { ok: false, reason: 'newerVersion', formatVersion: document.formatVersion }
  }

  for (const section of BACKUP_SECTIONS) {
    if (Object.hasOwn(document.sections, section) && !Array.isArray(document.sections[section])) {
      return { ok: false, reason: 'sectionNotArray', section }
    }
  }

  const context = {
    knownSettings: new Set(knownSettings),
    machineBoundSettings: new Set(machineBoundSettings),
  }

  const sections = {}
  const counts = {}

  for (const section of BACKUP_SECTIONS) {
    if (!Object.hasOwn(document.sections, section)) { continue }

    const { records, count } = readSection(section, document.sections[section], context)
    sections[section] = records
    counts[section] = count
  }

  const known = new Set(BACKUP_SECTIONS)

  return {
    ok: true,
    header: {
      formatVersion: document.formatVersion,
      appVersion: typeof document.appVersion === 'string' ? document.appVersion : null,
      installationId: typeof document.installationId === 'string' ? document.installationId : null,
    },
    sections,
    counts,
    unknownSections: Object.keys(document.sections).filter(name => !known.has(name)).sort(compareStrings),
  }
}

// #region the sections

/**
 * The key each section's records are sorted and told apart by. History is
 * upserted by video id, everything else by `_id`.
 * @param {BackupSection} section
 * @returns {(record: Record<string, any>) => string}
 */
function recordKey(section) {
  return section === 'history'
    ? record => String(record.videoId ?? '')
    : record => String(record._id ?? '')
}

/** The keys a history entry must have, as the history import requires them */
const HISTORY_REQUIRED_KEYS = ['author', 'authorId', 'isLive', 'lengthSeconds', 'published', 'timeWatched', 'title', 'type', 'videoId', 'watchProgress']

/** The keys a profile must have, as the subscriptions import requires them */
const PROFILE_REQUIRED_KEYS = ['_id', 'name', 'bgColor', 'textColor', 'subscriptions']

/** The keys a playlist video must have, as the playlists import requires them */
const PLAYLIST_VIDEO_REQUIRED_KEYS = ['videoId', 'title', 'lengthSeconds', 'timeAdded']

/**
 * One record checked: the record to write, or why it is left out. A playlist
 * also says how many of its videos were left out.
 * @typedef {{ record: Record<string, any>, videosLeftOut?: number } | { leftOut: LeftOutReason }} Checked
 */

/** @type {Record<BackupSection, (record: Record<string, any>, context: { knownSettings: Set<string>, machineBoundSettings: Set<string> }) => Checked>} */
const CHECKS = {
  profiles(record) {
    if (!hasKeys(record, PROFILE_REQUIRED_KEYS) || !isNonEmptyString(record._id) || !Array.isArray(record.subscriptions)) {
      return { leftOut: 'missingFields' }
    }

    return { record }
  },

  history(record) {
    if (!hasKeys(record, HISTORY_REQUIRED_KEYS) || !isNonEmptyString(record.videoId)) {
      return { leftOut: 'missingFields' }
    }

    return checkedPeerTube(record)
  },

  playlists(record) {
    if (!isNonEmptyString(record._id) || !hasKeys(record, ['playlistName']) || !Array.isArray(record.videos)) {
      return { leftOut: 'missingFields' }
    }

    const videos = []
    for (const video of record.videos) {
      if (!isPlainObject(video) || !hasKeys(video, PLAYLIST_VIDEO_REQUIRED_KEYS)) { continue }

      const checked = checkedPeerTube(video)
      if ('record' in checked) { videos.push(checked.record) }
    }

    const videosLeftOut = record.videos.length - videos.length

    return { record: videosLeftOut === 0 ? record : { ...record, videos }, videosLeftOut }
  },

  // What the Later import accepts, with the item's own place and alarm kept
  later(record) {
    if (!isNonEmptyString(record.videoId) || typeof record.title !== 'string') {
      return { leftOut: 'missingFields' }
    }

    const alarm = record.alarm != null && typeof record.alarm.at === 'number'
      ? { ...record.alarm, armedAt: typeof record.alarm.armedAt === 'number' ? record.alarm.armedAt : record.alarm.at }
      : null

    return {
      record: {
        ...record,
        _id: isNonEmptyString(record._id) ? record._id : record.videoId,
        addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0,
        position: typeof record.position === 'number' && Number.isFinite(record.position) ? record.position : 0,
        alarm,
      },
    }
  },

  searchHistory(record) {
    if (typeof record._id !== 'string' || typeof record.lastUpdatedAt !== 'number') {
      return { leftOut: 'missingFields' }
    }

    return { record }
  },

  settings(record, { knownSettings, machineBoundSettings }) {
    if (typeof record._id !== 'string' || !Object.hasOwn(record, 'value')) {
      return { leftOut: 'missingFields' }
    }

    if (machineBoundSettings.has(record._id)) {
      return { leftOut: 'machineBound' }
    }

    if (!knownSettings.has(record._id)) {
      return { leftOut: 'unknownSetting' }
    }

    return { record }
  },

  channels(record) {
    if (!isNonEmptyString(record._id)) {
      return { leftOut: 'missingFields' }
    }

    return { record }
  },

  aiVerdicts(record) {
    if (!isNonEmptyString(record._id) || typeof record.ai !== 'boolean' || typeof record.checkedAt !== 'number') {
      return { leftOut: 'missingFields' }
    }

    return { record }
  },
}

/**
 * @param {BackupSection} section
 * @param {unknown[]} input
 * @param {{ knownSettings: Set<string>, machineBoundSettings: Set<string> }} context
 * @returns {{ records: Record<string, any>[], count: SectionCount }}
 */
function readSection(section, input, context) {
  const key = recordKey(section)
  const seen = new Set()
  // A history entry is keyed by its video id, but the datastore will not take
  // two with the same _id either
  const seenIds = new Set()
  const records = []
  const leftOut = {}

  const leave = (reason, count = 1) => {
    leftOut[reason] = (leftOut[reason] ?? 0) + count
  }

  for (const raw of input) {
    if (!isPlainObject(raw)) {
      leave('missingFields')
      continue
    }

    const checked = CHECKS[section](raw, context)

    if ('leftOut' in checked) {
      leave(checked.leftOut)
      continue
    }

    const id = key(checked.record)
    const _id = checked.record._id
    if (seen.has(id) || (_id !== undefined && seenIds.has(_id))) {
      leave('duplicate')
      continue
    }

    seen.add(id)
    if (_id !== undefined) { seenIds.add(_id) }
    records.push(checked.record)

    if (checked.videosLeftOut > 0) {
      leave('playlistVideos', checked.videosLeftOut)
    }
  }

  return { records, count: { kept: records.length, leftOut } }
}

/**
 * A YouTube record as it is; a PeerTube one with its platform fields checked
 * as the imports check them, or left out when it cannot be one.
 * @param {Record<string, any>} record
 * @returns {Checked}
 */
function checkedPeerTube(record) {
  const { record: rest, fields } = splitImportedPlatformFields(record)

  if (fields === null) {
    return { leftOut: 'invalidPeerTube' }
  }

  return { record: rest === record ? record : { ...rest, ...fields } }
}

// #endregion the sections

// #region helpers

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * @param {Record<string, any>} record
 * @param {string[]} keys
 */
function hasKeys(record, keys) {
  return keys.every(key => Object.hasOwn(record, key))
}

/**
 * By code unit, so that the order is the same in every locale
 * @param {string} a
 * @param {string} b
 */
function compareStrings(a, b) {
  if (a < b) { return -1 }
  if (a > b) { return 1 }
  return 0
}

/**
 * A copy with the keys of every object sorted, at every level; arrays keep
 * their order
 * @param {unknown} value
 * @returns {any}
 */
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }

  if (isPlainObject(value)) {
    const sorted = {}
    for (const key of Object.keys(value).sort(compareStrings)) {
      sorted[key] = sortKeys(value[key])
    }
    return sorted
  }

  return value
}

// #endregion helpers
