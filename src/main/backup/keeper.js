import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'

import { BACKUP_SECTIONS, sortKeys, writeBackup } from '../../renderer/helpers/backup'
import { communitiesBackupSections } from '../../renderer/helpers/communities/backup.js'
import { foldLaterEvent, LATER_EVENTS } from '../../renderer/helpers/folds/later'
import { isEventedSection, recordKey } from '../../renderer/helpers/intentFields'
import { applyIntents } from '../../renderer/helpers/intentIndex'
import { addToRanges, compareEvents, parseSegmentName, rangesHold, readSegment, segmentName, writeEventLine } from '../../renderer/helpers/intentLog'
import { baseFileName, isBaseFileName, REBASE_THRESHOLD } from '../../renderer/helpers/keptBackup'
import { mergeStateRecords, readStateFile, SETTLED_BY_RULE, writeStateFile } from '../../renderer/helpers/stateFile'
import { capPending, ensureOwnIdentity, firstMeeting, PENDING_LOG_NAME } from './enrol'
import { MACHINE_BOUND_SETTINGS } from './machineBound'
import { backupsFolder, removeOldSafetyCopies, safetyCopyName } from './restore'

/**
 * The keeper: keeps the app's backup current in a folder chosen in the
 * settings, and takes it in when the app starts, so that switching machines
 * needs no export and no restore. Moving the folder between machines is the
 * sync tool's job.
 * The design is `.scratch/evented-sync/spec.md`.
 *
 * The folder has archives, a full backup gzipped and named by its hash
 * whose header says what it folded in, and per machine a log of its own
 * intents in segments and one state file of what it worked out for itself.
 * Each machine writes only its own files, an archive excepted, so there is
 * nothing to lock and no file two machines share.
 *
 * Everything it needs comes in as arguments, as for restore.js, so that a test
 * runs several keepers on one temporary folder with a file system that can
 * stop a write at any step. Every decision goes to the keeper log in the data
 * folder, which is what a problem found after days of use is traced with.
 */

export const TEMP_PREFIX = '.fjernsyn-tmp-'
export const STATE_FILE_NAME = 'keeper-state.json'
export const INTENT_INDEX_FILE_NAME = 'intent-index.json'
export const LOG_FILE_NAME = 'keeper.log'

export const TICK_MS = 60_000
export const QUIT_LIMIT_MS = 10_000
export const STARTUP_READ_LIMIT_MS = 30_000
export const SAFETY_COPY_EVERY_MS = 60 * 60_000
export const FOREIGN_TEMP_MS = 24 * 60 * 60_000
export const KEEP_MS = 7 * 24 * 60 * 60_000
export const LOG_CAP_BYTES = 1024 * 1024
export const AHEAD_MS = 5 * 60_000
const RENAME_TRIES = 5
const RENAME_RETRY_MS = 200
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * The sections an event can move, each with its own fold and the types this
 * version knows. A section that is not here travels as state alone, which is
 * what it did before any of this.
 */
const FOLDS = Object.freeze({
  later: { fold: foldLaterEvent, types: LATER_EVENTS },
})

const gunzip = promisify(gunzipCallback)

// #region types

/**
 * @typedef {object} KeeperStatus
 * @property {string | null} folder the backup folder, null when the keeper is off
 * @property {boolean} ready whether the startup check is done
 * @property {number | null} writtenAt when this machine last wrote the folder
 * @property {{ message: string, since: number } | null} failure while writes fail, `since` being the first failure in the row
 * @property {{ machineName: string | null, at: number } | null} mergedFrom the last time another machine's changes were merged
 */

/**
 * The keeper's memory, `backups/keeper-state.json` in the data folder
 * @typedef {object} KeeperState
 * @property {string | null} folder the folder the rest was about
 * @property {string | null} archive the hash of the archive the state file is a delta against
 * @property {number} segment this machine's current log segment, a new one at each archive
 * @property {number} seq the last sequence number this machine gave an event of its own
 * @property {Record<string, import('../../renderer/helpers/intentLog').Ranges>} applied the sequence numbers taken from each machine, this one included
 * @property {string | null} contentHash the content last written
 * @property {string | null} stateHash the state file last written, so that one is written again only when a state field has changed
 * @property {number} stateBytes the size of the state file last written, for the archiving threshold
 * @property {string | null} lastHostName the name of the computer this installation id last ran on
 */

/**
 * @typedef {object} DataChanges
 * @property {string[]} sections
 * @property {{ put: Record<string, any>[], removed: string[] } | null} history the entries put whole, and the videos whose entries went
 */

// #endregion types

/**
 * Wraps the writing methods of the datastores the backup covers, so that a
 * write raises the keeper's change flag. Reads never do. The callback forms
 * call these, so they are caught too.
 *
 * @param {Record<string, any>} datastores
 * @param {(section: string) => void} onWrite
 */
export function watchDatastores(datastores, onWrite) {
  for (const section of BACKUP_SECTIONS) {
    const datastore = datastores[section]

    for (const method of ['insertAsync', 'updateAsync', 'removeAsync']) {
      const original = datastore[method]

      datastore[method] = function (...args) {
        onWrite(section)
        return original.apply(this, args)
      }
    }
  }
}

/** @param {string | Buffer} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @param {string | null | undefined} hash */
function short(hash) {
  return hash ? hash.slice(0, 12) : '-'
}

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {unknown} error */
function isMissing(error) {
  return error?.code === 'ENOENT'
}

/** @param {string} installationId */
function stateFileName(installationId) {
  return `state-${installationId}.json`
}

/**
 * The machine a state file belongs to, or null when the name is not one
 * @param {string} name
 * @returns {string | null}
 */
function parseStateFileName(name) {
  const match = /^state-(.+)\.json$/.exec(name)

  return match === null ? null : match[1]
}

/**
 * One record's state fields as text, keys sorted, so that two of them are
 * compared whatever order their fields went in
 * @param {Record<string, any>} fields
 */
function fieldsText(fields) {
  return JSON.stringify(sortKeys(fields))
}

/**
 * This machine's data as it is now, kept in the data folder before another
 * machine's events are applied to it, so that a bad take in can be undone.
 * The name has the second in it, so a copy already written this second is as
 * good as another and the writing never clobbers one.
 *
 * @param {object} options
 * @param {string} options.dataFolder
 * @param {Pick<typeof fs, 'mkdir' | 'readdir' | 'rm' | 'writeFile'>} options.fileSystem
 * @param {number} options.at
 * @param {string} options.text the backup, as `writeBackup` makes it
 * @returns {Promise<string>} the name of the copy
 */
export async function writeSafetyCopy({ dataFolder, fileSystem, at, text }) {
  const folder = backupsFolder(dataFolder)
  const name = safetyCopyName(new Date(at))

  await fileSystem.mkdir(folder, { recursive: true })

  try {
    await fileSystem.writeFile(path.join(folder, name), text, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') { throw error }
  }

  await removeOldSafetyCopies(folder, fileSystem)

  return name
}

/**
 * @param {object} deps
 * @param {Record<string, any>} deps.datastores the eight the backup covers, by section name
 * @param {string} deps.dataFolder
 * @param {string} deps.appVersion
 * @param {string | (() => Promise<string>)} deps.installationId
 * @param {string | null} deps.machineName
 * @param {string | null} [deps.hostName] this computer's name, against which a data folder copied to another is caught
 * @param {(job: object) => Promise<any>} deps.runJob the worker's, or the job run inline
 * @param {(status: KeeperStatus) => void} [deps.onStatus]
 * @param {(changes: DataChanges) => void} [deps.onDataChanged] the open windows load the sections it names
 * @param {<T>(step: () => Promise<T>) => Promise<T>} [deps.inLaterQueue] the Later handler's queue, which the apply of a Later event runs in
 * @param {typeof fs} [deps.fileSystem]
 * @param {() => number} [deps.now] must agree with the file system's clock, as file ages are measured by it
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => string} [deps.makeToken]
 */
export function createKeeper({
  datastores,
  dataFolder,
  appVersion,
  installationId: installationIdSource,
  machineName,
  hostName = null,
  runJob,
  onStatus = () => {},
  onDataChanged = () => {},
  inLaterQueue = step => step(),
  fileSystem = fs,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  makeToken = () => randomBytes(8).toString('hex'),
}) {
  /** @type {string} */
  let installationId = typeof installationIdSource === 'string' ? installationIdSource : ''

  /** @type {KeeperState} */
  let state = emptyState(null)

  /**
   * The last intent applied to each key, `backups/intent-index.json` in the data folder
   * @type {import('../../renderer/helpers/intentIndex').IntentIndex}
   */
  let index = {}

  /**
   * This machine's intents since the last append, in the order they were made
   * @type {{ at: number, type: string, key: string, data: Record<string, any> }[]}
   */
  let buffered = []

  /** @type {KeeperStatus} */
  let status = {
    folder: null,
    ready: false,
    writtenAt: null,
    failure: null,
    mergedFrom: null,
  }

  /** Raised by every write to a datastore the backup covers */
  let changed = true

  /** When this machine last kept a safety copy, 0 so that the first take in keeps one */
  let lastSafetyCopyAt = 0

  /**
   * The archive last read or written, unpacked
   * @type {{ sha256: string, text: string } | null}
   */
  let archiveCache = null

  /**
   * The state records this machine last published, to take their times forward
   * @type {Record<string, import('../../renderer/helpers/stateFile').StateRecord>}
   */
  let published = {}

  let resolveReady
  const readyPromise = new Promise((resolve) => { resolveReady = resolve })

  // #region serialising

  let chain = Promise.resolve()

  /**
   * Runs one step at a time: a tick, an answer, the quit write. A step that
   * fails does not stop the ones after it.
   * @template T
   * @param {() => Promise<T>} step
   * @returns {Promise<T>}
   */
  function exclusive(step) {
    const run = chain.then(step)
    chain = run.catch(() => {})
    return run
  }

  // #endregion serialising

  // #region status and log

  function header() {
    return { appVersion, installationId, machineName }
  }

  /** @param {Partial<KeeperStatus>} patch */
  function setStatus(patch) {
    status = { ...status, ...patch }
    onStatus(snapshot())
  }

  /** @returns {KeeperStatus} */
  function snapshot() {
    return structuredClone(status)
  }

  function markReady() {
    if (!status.ready) {
      setStatus({ ready: true })
    }
    resolveReady()
  }

  let logChain = Promise.resolve()

  /**
   * One line per decision: names, short hashes, counts, never a record
   * @param {string} message
   */
  function log(message) {
    const line = `${new Date(now()).toISOString()} ${message}\n`

    logChain = logChain.then(async () => {
      const folder = backupsFolder(dataFolder)
      const file = path.join(folder, LOG_FILE_NAME)

      await fileSystem.mkdir(folder, { recursive: true })

      let size = 0
      try {
        size = (await fileSystem.stat(file)).size
      } catch {}

      if (size + Buffer.byteLength(line) > LOG_CAP_BYTES) {
        // A rename that fails (a viewer holding it on Windows) must not stop the log
        await fileSystem.rename(file, `${file}.1`).catch(() => {})
      }

      await fileSystem.appendFile(file, line, 'utf8')
    }).catch((error) => {
      console.error('Could not write the keeper log', error)
    })

    return logChain
  }

  // #endregion status and log

  // #region the keeper's memory

  /** @param {string | null} folder */
  function emptyState(folder) {
    return { folder, archive: null, segment: 0, seq: 0, applied: {}, contentHash: null, stateHash: null, stateBytes: 0, lastHostName: null }
  }

  /**
   * The state another folder leaves: what that folder held is unknown again,
   * while this machine's own counter and segment go on where they were, so
   * that no sequence number is ever given to two events.
   *
   * Its own sequence numbers go with the counter, as they are applied where
   * they are made. Every other machine's go with the folder: the machines of
   * the folder being left said nothing about the new one, and a range carried
   * across would hold back the events of a machine whose own numbers start
   * inside it.
   * @param {string | null} folder
   */
  function forFolder(folder) {
    const own = state.applied[installationId]

    return {
      ...emptyState(folder),
      segment: state.segment,
      seq: state.seq,
      applied: own === undefined ? {} : { [installationId]: own },
      lastHostName: state.lastHostName,
    }
  }

  async function loadState() {
    try {
      const text = await fileSystem.readFile(path.join(backupsFolder(dataFolder), STATE_FILE_NAME), 'utf8')
      const read = JSON.parse(text)
      const whole = (name, fallback) => Number.isInteger(read?.[name]) && read[name] >= 0 ? read[name] : fallback

      return {
        folder: typeof read?.folder === 'string' ? read.folder : null,
        archive: typeof read?.archive === 'string' && SHA256_HEX.test(read.archive) ? read.archive : null,
        segment: whole('segment', 0),
        seq: whole('seq', 0),
        applied: read?.applied !== null && typeof read?.applied === 'object' ? read.applied : {},
        contentHash: typeof read?.contentHash === 'string' ? read.contentHash : null,
        stateHash: typeof read?.stateHash === 'string' ? read.stateHash : null,
        stateBytes: whole('stateBytes', 0),
        lastHostName: typeof read?.lastHostName === 'string' ? read.lastHostName : null,
      }
    } catch (error) {
      if (!isMissing(error)) {
        log(`state file unreadable, starting afresh: ${errorText(error)}`)
      }
      return emptyState(null)
    }
  }

  async function loadIndex() {
    try {
      const text = await fileSystem.readFile(path.join(backupsFolder(dataFolder), INTENT_INDEX_FILE_NAME), 'utf8')
      const read = JSON.parse(text)
      return read !== null && typeof read === 'object' && !Array.isArray(read) ? read : {}
    } catch (error) {
      if (!isMissing(error)) {
        log(`intent index unreadable, starting afresh: ${errorText(error)}`)
      }
      return {}
    }
  }

  async function saveMemory() {
    const folder = backupsFolder(dataFolder)
    await fileSystem.mkdir(folder, { recursive: true })
    await writeAtomic(folder, STATE_FILE_NAME, JSON.stringify(state, null, 2) + '\n')
    await writeAtomic(folder, INTENT_INDEX_FILE_NAME, JSON.stringify(index) + '\n')
  }

  /**
   * The backup folder the setting names. A folder other than the one the
   * state is about leaves what is in that folder unknown.
   * @returns {Promise<string | null>}
   */
  async function currentFolder() {
    const setting = await datastores.settings.findOneAsync({ _id: 'backupFolder' })
    const folder = typeof setting?.value === 'string' && setting.value !== '' ? setting.value : null

    if (folder !== state.folder) {
      log(`folder is now ${folder ?? 'not set'}; the archive is unknown again`)
      state = forFolder(folder)
      published = {}
      archiveCache = null
      await saveMemory()
    }

    if (status.folder !== folder) {
      setStatus({ folder })
    }

    return folder
  }

  // #endregion the keeper's memory

  // #region files

  /**
   * Written to a temporary name in the same folder and renamed into place,
   * so that neither the disk nor the sync tool ever sees half a file
   * @param {string} folder
   * @param {string} name
   * @param {string | Uint8Array} data
   */
  async function writeAtomic(folder, name, data) {
    const temporary = path.join(folder, `${TEMP_PREFIX}${installationId}-${makeToken()}`)

    await fileSystem.writeFile(temporary, data)

    for (let tries = 1; ; tries++) {
      try {
        await fileSystem.rename(temporary, path.join(folder, name))
        return
      } catch (error) {
        // Windows refuses to replace a file another program holds open, as a
        // sync tool or a virus scanner may for a moment
        if (tries < RENAME_TRIES && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) {
          await sleep(RENAME_RETRY_MS * tries)
          continue
        }

        await fileSystem.rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    }
  }

  /**
   * The archive this machine's state file is a delta against, unpacked and
   * its hash checked. Null when it is not in the folder or does not read: the
   * build then writes a fresh one, and no wrong archive is ever read.
   * @param {string} folder
   * @returns {Promise<{ sha256: string, text: string } | null>}
   */
  async function readArchive(folder) {
    if (state.archive === null) { return null }
    if (archiveCache?.sha256 === state.archive) { return archiveCache }

    const file = baseFileName(state.archive)

    let packed
    try {
      packed = await fileSystem.readFile(path.join(folder, file))
    } catch (error) {
      log(`archive ${file} could not be read (${errorText(error)}): writing a fresh one`)
      return null
    }

    let text = null
    try {
      text = (await gunzip(packed)).toString('utf8')
    } catch {}

    if (text === null || sha256(text) !== state.archive) {
      log(`archive ${file} does not match its name: writing a fresh one`)
      return null
    }

    archiveCache = { sha256: state.archive, text }
    return archiveCache
  }

  /**
   * @param {string} file
   * @returns {Promise<number>} 0 when it is not there
   */
  async function sizeOf(file) {
    try {
      return (await fileSystem.stat(file)).size
    } catch {
      return 0
    }
  }

  /**
   * Leftover temporary files: this keeper's own at once, another's once a day old
   * @param {string} folder
   * @param {{ own: boolean }} options
   */
  async function removeTemporaryFiles(folder, { own }) {
    let names
    try {
      names = await fileSystem.readdir(folder)
    } catch {
      return
    }

    const mine = `${TEMP_PREFIX}${installationId}-`

    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) { continue }

      try {
        const isMine = name.startsWith(mine)

        if (isMine && !own) { continue }

        if (!isMine) {
          const { mtimeMs } = await fileSystem.stat(path.join(folder, name))
          if (now() - mtimeMs <= FOREIGN_TEMP_MS) { continue }
        }

        await fileSystem.rm(path.join(folder, name), { force: true })
        log(`removed leftover temporary file ${name}`)
      } catch (error) {
        log(`could not remove temporary file ${name}: ${errorText(error)}`)
      }
    }
  }

  /**
   * An archive that is not the current one, and a segment of this machine's
   * own that it has closed, once either is more than seven days old. Another
   * machine may be a week behind, or its delivery may be, and it reads what
   * is there. No other machine's files are touched.
   * @param {string} folder
   */
  async function removeOldFiles(folder) {
    let names
    try {
      names = await fileSystem.readdir(folder)
    } catch {
      return
    }

    const current = state.archive === null ? null : baseFileName(state.archive)

    for (const name of names) {
      const segment = parseSegmentName(name)
      const ownClosed = segment !== null && segment.installationId === installationId && segment.index < state.segment
      const superseded = isBaseFileName(name) && name !== current

      if (!ownClosed && !superseded) { continue }

      try {
        const { mtimeMs } = await fileSystem.stat(path.join(folder, name))
        if (now() - mtimeMs <= KEEP_MS) { continue }

        await fileSystem.rm(path.join(folder, name), { force: true })
        log(`removed ${name}, more than seven days old`)
      } catch (error) {
        log(`could not remove ${name}: ${errorText(error)}`)
      }
    }
  }

  // #endregion files

  // #region collecting

  /**
   * Every section as the datastores have it. Settings are every stored one
   * that does not belong to the machine, known to this version or not.
   * @returns {Promise<Record<string, Record<string, any>[]>>}
   */
  async function collect() {
    const sections = {}

    for (const section of BACKUP_SECTIONS) {
      const datastore = datastores[section]
      // Through the datastore's queue, so that it has loaded
      await datastore.countAsync({})
      const records = datastore.getAllData()

      sections[section] = section === 'settings'
        ? records.filter(record => typeof record._id === 'string' && !MACHINE_BOUND_SETTINGS.has(record._id) && record.value !== undefined)
        : records
    }

    // The sources without this machine's refresh times, and no share of
    // HackerTube's, which the bundle rebuilds, or of a source not followed
    return { ...sections, ...communitiesBackupSections(sections.communitySources, sections.communityShares) }
  }

  // #endregion collecting

  // #region writing

  /**
   * What the archive has folded in: the top of each machine's applied
   * sequence numbers. This machine's own are in there with the rest, as an
   * intent of its own is applied where it is made.
   * @returns {Record<string, number>}
   */
  function currentCut() {
    /** @type {Record<string, number>} */
    const cut = {}

    for (const [by, ranges] of Object.entries(state.applied)) {
      const top = ranges.length > 0 ? ranges[ranges.length - 1][1] : 0
      if (top > 0) {
        cut[by] = top
      }
    }

    return cut
  }

  function pendingFile() {
    return path.join(backupsFolder(dataFolder), PENDING_LOG_NAME)
  }

  /**
   * @param {number} held
   * @param {number} kept
   */
  function reportTheCap(held, kept) {
    if (kept < held) {
      log(`the pending log is past its cap: ${held - kept} of the oldest intents go, and their keys enrol as a union`)
    }
  }

  /**
   * The intents recorded before this machine was pointed at a folder, kept in
   * the data folder so that a week of use beforehand is not thrown away. They
   * are written without a sequence number, which is given when they become
   * this machine's first segment.
   */
  async function savePending() {
    const taken = buffered.slice()
    if (taken.length === 0) { return }

    const folder = backupsFolder(dataFolder)
    await fileSystem.mkdir(folder, { recursive: true })

    let kept = []
    try {
      kept = readSegment(await fileSystem.readFile(pendingFile(), 'utf8')).events
    } catch (error) {
      if (!isMissing(error)) { log(`the pending log could not be read, starting afresh: ${errorText(error)}`) }
    }

    const held = [...kept, ...taken.map(event => ({ ...event, seq: 0, by: installationId }))]
    const all = capPending(held, now())

    reportTheCap(held.length, all.length)
    await writeAtomic(folder, PENDING_LOG_NAME, all.map(writeEventLine).join(''))

    buffered = buffered.slice(taken.length)
    log(`no folder yet: ${taken.length} intent${taken.length === 1 ? '' : 's'} kept pending, ${all.length} in the log`)
  }

  /**
   * The pending log, capped, for the append that makes it this machine's
   * first segment
   * @returns {Promise<{ at: number, type: string, key: string, data: Record<string, any> }[]>}
   */
  async function takePending() {
    let text
    try {
      text = await fileSystem.readFile(pendingFile(), 'utf8')
    } catch {
      return []
    }

    const held = readSegment(text).events
    const kept = capPending(held, now())

    reportTheCap(held.length, kept.length)

    return kept.map(({ at, type, key, data }) => ({ at, type, key, data }))
  }

  /**
   * This machine's intents since the last append, stamped and written to the
   * end of its own current segment. Its own intents are applied intents, so
   * each takes its sequence number into the applied ranges and its key into
   * the index.
   *
   * The whole buffer goes down before the tick decides whether to archive, so
   * a new segment never starts between two events of one write: Later's
   * addition and the alarm armed with it are only right in the order they
   * were made, and a reader takes each segment's lines in turn.
   *
   * @param {string} folder
   */
  async function appendOwnEvents(folder) {
    const own = buffered.slice()
    const pending = await takePending()
    const taken = [...pending, ...own]
    if (taken.length === 0) { return }

    const name = segmentName(installationId, state.segment)
    const events = taken.map(({ at, type, key, data }, position) => ({
      seq: state.seq + position + 1,
      at,
      by: installationId,
      type,
      key,
      data,
    }))

    await fileSystem.appendFile(path.join(folder, name), events.map(writeEventLine).join(''), 'utf8')

    // Only once the append has landed. A crash in between leaves the pending
    // intents to be appended a second time, under sequence numbers of their
    // own, and the index settles the repeat against the first: same key, same
    // time, so it is not newer and changes nothing. Removing the file first
    // would lose them outright.
    if (pending.length > 0) {
      await fileSystem.rm(pendingFile(), { force: true }).catch(() => {})
      log(`the pending log became ${name}: ${pending.length} intent${pending.length === 1 ? '' : 's'} from before the folder was chosen`)
    }

    buffered = buffered.slice(own.length)

    for (const event of events) {
      state.seq = event.seq
      state.applied[installationId] = addToRanges(state.applied[installationId] ?? [], event.seq)
      index[event.key] = { at: event.at, by: event.by, seq: event.seq }
    }

    await saveMemory()
    log(`appended ${events.length} intent${events.length === 1 ? '' : 's'} to ${name}, up to ${state.seq}`)
  }

  /**
   * The events of every segment this machine's id owns, as the folder has
   * them, for the identity check before anything is written under that id
   * @param {string} folder
   * @returns {Promise<import('../../renderer/helpers/intentLog').IntentEvent[]>}
   */
  async function readOwnSegments(folder) {
    let names
    try {
      names = await fileSystem.readdir(folder)
    } catch {
      return []
    }

    const events = []

    for (const name of names.sort()) {
      if (parseSegmentName(name)?.installationId !== installationId) { continue }

      try {
        events.push(...readSegment(await fileSystem.readFile(path.join(folder, name), 'utf8')).events)
      } catch {}
    }

    return events
  }

  /**
   * Which sequence numbers this machine has given away comes from its own
   * segment, not from the state file beside it. The append lands before the
   * save, so a save that never happened would let the next event reuse a
   * number: every other machine counts it as applied already, so that intent
   * never travels and nothing says so.
   *
   * The number is taken from the segment and never reserved before the
   * append, because a reservation a crash cut short would leave a gap no
   * event ever fills, and a machine's events are applied in order.
   *
   * @param {string} folder
   */
  async function catchUpWithOwnSegment(folder) {
    let names
    try {
      names = await fileSystem.readdir(folder)
    } catch {
      return
    }

    const own = names
      .map(name => ({ name, parsed: parseSegmentName(name) }))
      .filter(({ parsed }) => parsed?.installationId === installationId)

    if (own.length === 0) { return }

    // The folder may be ahead of the saved index, from a crash in the window
    // after a roll: the number has to come from every segment this machine
    // owns, or the last one's would be given away again
    const segment = Math.max(state.segment, ...own.map(({ parsed }) => parsed.index))
    const before = { seq: state.seq, segment: state.segment }
    let torn = false

    for (const { name, parsed } of own) {
      let text
      try {
        text = await fileSystem.readFile(path.join(folder, name), 'utf8')
      } catch {
        continue
      }

      const read = readSegment(text)
      if (parsed.index === segment) {
        torn = read.partial
      }

      // Whatever wrote a line of this machine's own segment, the number on it
      // is gone: a data folder copied to a second machine puts two machines
      // on one id, and handing the number out again is the one way this
      // design corrupts a folder
      for (const event of read.events) {
        state.seq = Math.max(state.seq, event.seq)
        state.applied[installationId] = addToRanges(state.applied[installationId] ?? [], event.seq)
      }
    }

    if (torn) {
      // A newline ends the line a crash cut short. It then reads as a line
      // that is not an event and is skipped, where an event appended straight
      // after it would be glued to it and lost with it. Appending ends a line
      // and rewrites none.
      await fileSystem.appendFile(path.join(folder, segmentName(installationId, segment)), '\n', 'utf8')
      log(`segment ${segmentName(installationId, segment)} ended in half a line: closed it`)
    }

    if (state.seq === before.seq && segment === before.segment) { return }

    state.segment = segment
    log(`segment ${segmentName(installationId, segment)} is this machine's latest, past what the state file counted: up to ${state.seq}`)
    await saveMemory()
  }

  /**
   * The last intent applied to each key, worked out again from the folder's
   * segments when the index has been lost with the keeper's memory. Only the
   * events the applied ranges hold, which is what the index says: the ranges
   * come back from this machine's own segment and from the archive's cut, and
   * an event this machine has yet to apply must not be indexed before it is.
   *
   * Without this an index entry lost with the saved state stays lost, and an
   * older event from another machine wins a key this machine has settled: a
   * video it took out of Later comes back from the addition that put it there.
   *
   * @param {string} folder
   */
  async function rebuildIndex(folder) {
    let names
    try {
      names = await fileSystem.readdir(folder)
    } catch {
      return
    }

    const known = new Set(Object.values(FOLDS).flatMap(({ types }) => types))

    for (const name of names.sort()) {
      const segment = parseSegmentName(name)
      if (segment === null) { continue }

      let text
      try {
        text = await fileSystem.readFile(path.join(folder, name), 'utf8')
      } catch {
        continue
      }

      for (const event of readSegment(text).events) {
        if (event.by !== segment.installationId || !known.has(event.type)) { continue }
        if (!rangesHold(state.applied[event.by] ?? [], event.seq)) { continue }

        const held = index[event.key]

        if (held === undefined || compareEvents({ ...held, seq: held.seq ?? event.seq }, event) < 0) {
          index[event.key] = { at: event.at, by: event.by, seq: event.seq }
        }
      }
    }

    const keys = Object.keys(index).length
    if (keys === 0) { return }

    await saveMemory()
    log(`the intent index was lost: ${keys} key${keys === 1 ? '' : 's'} worked out again from the segments`)
  }

  /**
   * The records to publish, each with the time this machine last changed its
   * state fields: a record whose fields are what this machine published
   * before keeps the time it published them, and only one that has really
   * moved takes the time of this write.
   *
   * The build works the records out against the archive, which says what the
   * fields are and not when they were last touched, so a machine with a
   * stale value would stamp it afresh on every write and beat the newer value
   * another machine published earlier. Two machines then bounce a watch
   * progress between them for as long as both run.
   *
   * @param {Record<string, import('../../renderer/helpers/stateFile').StateRecord>} records
   */
  function withPublishedTimes(records) {
    for (const [key, record] of Object.entries(records)) {
      const before = published[key]

      if (before !== undefined && fieldsText(before.fields) === fieldsText(record.fields)) {
        record.at = before.at
      }
    }

    return records
  }

  /**
   * The state file this machine last left in the folder, so that a restart
   * does not stamp every record afresh. Its own file, and the only one this
   * machine ever reads for itself.
   * @param {string} folder
   */
  async function readOwnStateFile(folder) {
    let text
    try {
      text = await fileSystem.readFile(path.join(folder, stateFileName(installationId)), 'utf8')
    } catch {
      return {}
    }

    const read = readStateFile(text)
    return read.ok ? read.state.records : {}
  }

  /**
   * The tick's write: this machine's own intents appended, then an archive
   * when its segment and state file have grown past the threshold, then its
   * state file. Nothing is written when nothing changed.
   * @param {string} folder
   */
  async function write(folder) {
    try {
      // Lowered before the append, so that an intent recorded while this
      // write runs raises it again and the next tick, or the quit, takes it
      const wanted = changed
      changed = false

      await appendOwnEvents(folder)

      if (!wanted) { return }

      const started = now()
      const segmentBytes = await sizeOf(path.join(folder, segmentName(installationId, state.segment)))
      const wantArchive = segmentBytes + state.stateBytes > REBASE_THRESHOLD
      const archive = await readArchive(folder)

      const sections = await collect()
      const result = await runJob({
        type: 'build',
        sections,
        header: header(),
        cut: currentCut(),
        archive,
        at: now(),
        lastContentHash: state.contentHash,
        wantArchive,
      })

      if (result.unchanged) {
        log(`content unchanged (${short(result.contentHash)}), ${now() - started} ms`)
        return
      }

      if (result.newArchive !== null) {
        await writeAtomic(folder, result.newArchive.file, result.newArchive.gz)
        archiveCache = { sha256: result.newArchive.sha256, text: result.newArchive.text }
        state.archive = result.newArchive.sha256
        state.segment += 1
        log(`wrote archive ${result.newArchive.file} (${result.newArchive.text.length} chars); segment ${state.segment} starts`)
      }

      const records = withPublishedTimes(result.records)
      const stateText = writeStateFile({ archive: state.archive, records })
      const stateHash = sha256(stateText)
      published = records

      // An intent moves a record without moving a state field, so the content
      // changing is not reason enough: the file is the same bytes, and the
      // sync tool would carry it to the other machine for nothing
      if (stateHash === state.stateHash) {
        log(`no state field changed: the state file stays as it is, ${now() - started} ms`)
      } else {
        await writeAtomic(folder, stateFileName(installationId), stateText)

        state.stateBytes = stateText.length
        state.stateHash = stateHash

        const counts = Object.entries(sections).map(([name, held]) => `${name} ${held.length}`).join(', ')
        log(`wrote state file: ${Object.keys(records).length} records, ${stateText.length} chars, against archive ${short(state.archive)}, ${counts}, ${now() - started} ms`)
      }

      state.contentHash = result.contentHash
      await saveMemory()

      await removeOldFiles(folder)
      await removeTemporaryFiles(folder, { own: false })

      setStatus({ writtenAt: now(), failure: null })
    } catch (error) {
      changed = true
      const message = errorText(error)
      log(`couldn't write: ${message}`)
      setStatus({ failure: { message, since: status.failure?.since ?? now() } })
    }
  }

  // #endregion writing

  // #region taking in

  /**
   * One machine's unapplied events, in sequence order and stopping at its
   * first gap. A machine's own events are totally ordered by `seq`, and one
   * applied before its predecessors lands in a list they have not shaped yet:
   * a video added after another reaches the end of the list when the addition
   * it names has not arrived. So it waits for the tick that fills the gap.
   *
   * @param {string} by
   * @param {import('../../renderer/helpers/intentLog').IntentEvent[]} events
   */
  function inSequenceOrder(by, events) {
    const ranges = state.applied[by] ?? []
    const contiguous = ranges.length > 0 && ranges[0][0] === 1 ? ranges[0][1] : 0
    const taken = []
    let next = contiguous + 1

    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      if (event.seq < next) { continue }
      if (event.seq > next) { break }

      next += 1
      if (!rangesHold(ranges, event.seq)) { taken.push(event) }
    }

    return taken
  }

  /**
   * Every other machine's events this one has not taken. Only the segments
   * are read: an archive decides nothing here, since what it folded in is
   * already in this machine's applied ranges or still above the cut.
   * @param {string} folder
   */
  async function unappliedEvents(folder) {
    let names
    try {
      names = await fileSystem.readdir(folder)
    } catch {
      return []
    }

    /** @type {Map<string, import('../../renderer/helpers/intentLog').IntentEvent[]>} */
    const byMachine = new Map()

    for (const name of names.sort()) {
      const segment = parseSegmentName(name)
      if (segment === null || segment.installationId === installationId) { continue }

      let text
      try {
        text = await fileSystem.readFile(path.join(folder, name), 'utf8')
      } catch (error) {
        log(`segment ${name} could not be read: ${errorText(error)}`)
        continue
      }

      const theirs = readSegment(text).events.filter(event => event.by === segment.installationId)
      byMachine.set(segment.installationId, (byMachine.get(segment.installationId) ?? []).concat(theirs))
    }

    return [...byMachine].flatMap(([by, events]) => inSequenceOrder(by, events))
  }

  /**
   * The unapplied events, and null when the folder has not answered in time.
   * A folder on a network mount that has gone away answers no read at all,
   * and the startup waits for this one before the data may load.
   *
   * The limit is on the read alone. A read given up on never reaches the
   * apply, so what it finds when it finally comes back is dropped and no
   * second take in can be applying beside it. The next tick reads again, from
   * ranges nothing has moved.
   *
   * @param {string} folder
   * @param {number | null} limit
   */
  async function readInTime(folder, limit) {
    if (limit === null) { return unappliedEvents(folder) }

    const events = await Promise.race([unappliedEvents(folder), sleep(limit).then(() => null)])

    if (events === null) {
      log(`the folder did not answer in ${limit / 1000} s: nothing taken in, and the next tick reads it again`)
    }

    return events
  }

  /**
   * Every machine's state file, this one's own with them: the union rule
   * reads each machine's list, and leaving this machine's out would offer the
   * starter sources again over its own unfollows.
   * @param {string} folder
   * @returns {Promise<import('../../renderer/helpers/stateFile').StateFileOf[]>}
   */
  async function readStateFiles(folder) {
    let names
    try {
      names = await fileSystem.readdir(folder)
    } catch {
      return []
    }

    const files = []

    for (const name of names.sort()) {
      const by = parseStateFileName(name)
      if (by === null) { continue }

      let text
      try {
        text = await fileSystem.readFile(path.join(folder, name), 'utf8')
      } catch (error) {
        log(`state file ${name} could not be read: ${errorText(error)}`)
        continue
      }

      const read = readStateFile(text)
      if (!read.ok) {
        log(`state file ${name} does not read as one (${read.reason})`)
        continue
      }

      files.push({ by, state: read.state })
    }

    return files
  }

  /**
   * Each key's state fields with the newest `at` across the folder, written
   * onto the record the events have just decided.
   *
   * A key this machine has no record for makes one, where the section names
   * no intent field: nothing else says that record is there, so the state
   * files carry its existence, as the union did before any of this. Where
   * events decide existence, `later` alone today, state never makes a record.
   * @param {string} folder
   * @returns {Promise<string[]>} the sections whose records moved
   */
  async function mergeState(folder) {
    const files = await readStateFiles(folder)
    if (files.length === 0) { return [] }

    const merged = mergeStateRecords(files)
    const byNewest = new Map(Object.entries(merged).map(([key, record]) => [key, fieldsText(record.fields)]))

    // The sources as the events have just left them, so that a share of one
    // unfollowed in this very tick is dropped against the list they made
    const sections = await collect()

    for (const settle of Object.values(SETTLED_BY_RULE)) {
      settle(merged, { files, sections })
    }

    /** @type {Map<string, string[]>} */
    const keysBySection = new Map()

    for (const key of Object.keys(merged)) {
      const section = key.slice(0, key.indexOf('/'))
      if (!BACKUP_SECTIONS.includes(section)) { continue }

      keysBySection.set(section, [...(keysBySection.get(section) ?? []), key])
    }

    // In turn with the Later handler's writes where a Later record is among
    // the keys, for the reason the apply runs in that queue: the records are
    // read below and written further down, and a local write in between is
    // written over by the copy read here
    const inTurn = keysBySection.has('later') ? inLaterQueue : step => step()

    return inTurn(async () => {
      /** @type {{ section: string, record: Record<string, any> }[]} */
      const writes = []

      for (const [section, keys] of keysBySection) {
        const datastore = datastores[section]

        await datastore.countAsync({})
        const here = new Map(datastore.getAllData().map(record => [recordKey(section, record), record]))

        for (const key of keys) {
          const record = here.get(key)
          const settled = merged[key]

          // A record the merge settled on this machine's own say-so is here
          // already, and writing it back would undo whatever has changed since
          // that state file was written, watch progress above all. A record it
          // no longer has is one this machine removed since, which this would
          // put back. A rule's answer belongs to no one machine, so a record a
          // rule changed is written whichever machine the merge named.
          if (settled.by === installationId && byNewest.get(key) === fieldsText(settled.fields)) { continue }

          if (record === undefined) {
            const id = key.slice(section.length + 1)

            // Where no intent field is named, nothing but the state files says
            // a record is there, so they carry its existence as the union did
            // before any of this. An evented section's existence is its events'
            // alone, and a state file never brings back what one removed.
            // A key of more parts than an id names something inside a record,
            // which a later version keys this way and this one cannot make.
            if (isEventedSection(section) || id.includes('/')) { continue }

            writes.push({ section, record: { ...settled.fields, _id: id } })
            continue
          }

          const after = { ...record, ...settled.fields, _id: record._id }
          if (fieldsText(after) === fieldsText(record)) { continue }

          writes.push({ section, record: after })
        }
      }

      if (writes.length === 0) { return [] }

      await keepSafetyCopy()

      for (const { section, record } of writes) {
        await datastores[section].updateAsync({ _id: record._id }, record, { upsert: true })
      }

      const moved = [...new Set(writes.map(({ section }) => section))]
      log(`took state in for ${writes.length} record${writes.length === 1 ? '' : 's'} from ${files.length} state file${files.length === 1 ? '' : 's'}: ${moved.join(', ')}`)

      return moved
    })
  }

  /**
   * The data as it is now, before another machine's say-so changes it. The
   * first take in after a start keeps one, and after that one an hour.
   */
  async function keepSafetyCopy() {
    // A clock put back makes the last copy look like one from the future,
    // which must not pass for a copy kept within the hour
    const since = now() - lastSafetyCopyAt
    if (since >= 0 && since < SAFETY_COPY_EVERY_MS) { return }

    const name = await writeSafetyCopy({
      dataFolder,
      fileSystem,
      at: now(),
      text: writeBackup({ ...header(), sections: await collect() }),
    })

    lastSafetyCopyAt = now()
    log(`kept a safety copy, ${name}`)
  }

  /**
   * One section's events onto its records, through the intent index, and what
   * came of it written to the datastore. Removals go first: a record may come
   * back under another id.
   *
   * It runs in the section's own write queue where it has one. The records
   * are read once and written one at a time, and every await between lets a
   * local write through, which this would then write back as it read it.
   * @param {string} section
   * @param {import('../../renderer/helpers/intentLog').IntentEvent[]} events
   * @returns {Promise<{ changed: boolean, applied: import('../../renderer/helpers/intentLog').IntentEvent[] }>}
   */
  function applySection(section, events) {
    const inTurn = section === 'later' ? inLaterQueue : step => step()

    return inTurn(async () => {
      const { fold, types } = FOLDS[section]
      const datastore = datastores[section]

      await datastore.countAsync({})
      const records = new Map(datastore.getAllData().map(record => [recordKey(section, record), structuredClone(record)]))

      const result = applyIntents({ records, index, events, foldEvent: fold, knows: type => types.includes(type) })

      for (const key of result.remove) {
        await datastore.removeAsync({ _id: key.slice(section.length + 1) }, {})
      }

      for (const record of result.put) {
        await datastore.updateAsync({ _id: record._id }, record, { upsert: true })
      }

      // Only once every record is down. An index ahead of the datastore counts
      // an intent applied that never reached it, and the next tick sees the
      // event as older than the index and drops it for good
      index = result.index

      for (const event of result.skipped) {
        log(`skipped ${event.type} from ${short(event.by)}, which this version does not know`)
      }

      return { changed: result.put.length > 0 || result.remove.length > 0, applied: result.applied }
    })
  }

  /**
   * Another machine's intents onto this machine's records. A safety copy is
   * kept first: this and the state merge are where another machine's say-so
   * changes the data on this one.
   * @param {string} folder
   * @param {number | null} limit
   * @returns {Promise<string[]>} the sections whose records moved
   */
  async function takeIn(folder, limit) {
    const events = await readInTime(folder, limit)
    if (events === null || events.length === 0) { return [] }

    const started = now()
    await keepSafetyCopy()

    for (const ahead of events.filter(({ at }) => at - now() > AHEAD_MS)) {
      log(`${ahead.type} from ${short(ahead.by)} is dated ${Math.round((ahead.at - now()) / 60_000)} minutes ahead of this machine's clock`)
    }

    const sections = []

    for (const section of Object.keys(FOLDS)) {
      const theirs = events.filter(event => event.key.split('/')[0] === section)
      if (theirs.length === 0) { continue }

      const { changed: moved, applied } = await applySection(section, theirs)

      for (const event of applied) {
        state.applied[event.by] = addToRanges(state.applied[event.by] ?? [], event.seq)
        log(`applied ${event.type} to ${event.key} from ${short(event.by)}`)
      }

      if (moved) { sections.push(section) }
    }

    await saveMemory()

    log(`took in ${events.length} intent${events.length === 1 ? '' : 's'}, ${sections.length > 0 ? sections.join(', ') : 'nothing changed here'}, ${now() - started} ms`)

    return sections
  }

  // #endregion taking in

  // #region meeting a folder

  /**
   * The first meeting with a folder: a machine enrolled, a machine updated,
   * and a machine that lost its keeper state, all one path. The folder's
   * archive is merged in as a union and nothing of this machine's own is
   * removed, so the machine that lagged a day behind keeps everything it did
   * while it lagged.
   *
   * It runs while this machine has no archive of the folder, so once per
   * folder, and it is the largest write this code makes to the datastores,
   * which is why it keeps a safety copy first.
   *
   * @param {string} folder
   * @returns {Promise<string[]>} the sections whose records moved
   */
  async function meetFolder(folder) {
    if (state.archive !== null) { return [] }

    const { archive, toApply, applied } = await firstMeeting({
      folder,
      fileSystem,
      sections: await collect(),
      machineBound: MACHINE_BOUND_SETTINGS,
      applied: state.applied,
      log,
    })

    if (archive === null) { return [] }

    const sections = Object.keys(toApply)

    if (sections.length > 0) {
      await keepSafetyCopy()
    }

    for (const section of sections) {
      const { put, remove } = toApply[section]

      for (const id of remove) {
        await datastores[section].removeAsync({ _id: id }, {})
      }

      for (const record of put) {
        await datastores[section].updateAsync({ _id: record._id }, record, { upsert: true })
      }
    }

    state.archive = archive
    state.applied = applied
    await saveMemory()

    return sections
  }

  // #endregion meeting a folder

  // #region the steps

  /**
   * The id this machine writes its own files under, settled before anything
   * is read or written under it. A data folder copied to a second machine
   * puts two machines on one id, one segment name and one counter, and they
   * give one sequence number to two events in a folder that has no lock,
   * which is the one way this design corrupts a folder.
   *
   * The copy takes a new id, starts a segment of its own, and leaves every
   * file of the old id to the machine it was copied from. The old id's
   * applied ranges stay where they are: those events are in this machine's
   * data already, and the twin's new ones come in as any other machine's do.
   *
   * @param {string | null} folder
   */
  async function settleOwnIdentity(folder) {
    const was = installationId

    installationId = await ensureOwnIdentity({
      installationId: was,
      hostName,
      lastHostName: state.lastHostName,
      ownSegment: folder === null ? [] : await readOwnSegments(folder),
    })

    const minted = installationId !== was
    const moved = hostName !== null && state.lastHostName !== hostName

    if (minted) {
      state.segment = 0
      state.seq = 0

      await datastores.settings.updateAsync({ _id: 'installationId' }, { _id: 'installationId', value: installationId }, { upsert: true })
      log(`this data folder has been on another machine: a new installation id, and ${was}'s files are left to it`)
    }

    if (moved) {
      state.lastHostName = hostName
    }

    if (minted || moved) {
      await saveMemory()
    }
  }

  /** @param {number | null} limit on the read of the folder's segments */
  async function startup(limit) {
    if (typeof installationIdSource === 'function') {
      installationId = await installationIdSource()
    }

    state = await loadState()
    index = await loadIndex()

    const folder = await currentFolder()

    await settleOwnIdentity(folder)

    if (folder === null) {
      log('startup: no folder set')
      markReady()
      return
    }

    log(`startup: folder ${folder}, archive ${short(state.archive)}, segment ${state.segment}, machine ${machineName ?? '-'}`)

    await removeTemporaryFiles(folder, { own: true })
    // The state file is written the same way, in the data folder
    await removeTemporaryFiles(backupsFolder(dataFolder), { own: true })

    published = await readOwnStateFile(folder)

    await catchUpWithOwnSegment(folder)
    // What was applied before this machine lost its index is read back first,
    // so that the pending intents promoted below meet a whole index
    if (Object.keys(index).length === 0 && Object.keys(state.applied).length > 0) {
      await rebuildIndex(folder)
    }

    // Before the folder is taken in, so that an intent made before enrolling
    // is in the index with the time it happened when the folder's events meet
    // it: an unsubscribe there on Tuesday and a subscribe here on Wednesday
    // must end the same way round whichever machine is doing the reading
    await appendOwnEvents(folder)

    await takeInSafely(folder, limit)

    markReady()
  }

  async function tick() {
    if (!status.ready) { return }

    const folder = await currentFolder()
    if (folder === null) {
      await savePending()
      return
    }

    await takeInSafely(folder)
    await write(folder)
  }

  /**
   * The events and then the state files, with the open windows told which
   * sections either of them moved. A half that fails leaves the folder's changes
   * where they are and the other half goes on, as does the write, so one
   * unreadable file never stops this machine writing its own. Nothing is
   * applied without a safety copy, so a copy that cannot be written stops the
   * take in here.
   * @param {string} folder
   * @param {number | null} [limit] on the read of the segments, at startup
   */
  async function takeInSafely(folder, limit = null) {
    const sections = new Set()

    try {
      for (const section of await meetFolder(folder)) { sections.add(section) }
    } catch (error) {
      log(`couldn't meet the folder: ${errorText(error)}`)
    }

    try {
      for (const section of await takeIn(folder, limit)) { sections.add(section) }
    } catch (error) {
      log(`couldn't take in: ${errorText(error)}`)
    }

    try {
      for (const section of await mergeState(folder)) { sections.add(section) }
    } catch (error) {
      log(`couldn't take the state files in: ${errorText(error)}`)
    }

    if (sections.size > 0) {
      onDataChanged({ sections: [...sections], history: null })
      setStatus({ mergedFrom: { machineName: null, at: now() } })
    }
  }

  async function folderChosenStep() {
    const folder = await currentFolder()
    state = forFolder(folder)
    await saveMemory()

    setStatus({ failure: null, writtenAt: null })

    if (folder === null) { return }

    log(`folder chosen: ${folder}`)
    changed = true
    await appendOwnEvents(folder)
    await takeInSafely(folder)
    await write(folder)
  }

  async function stopStep() {
    log('stop keeping: setting cleared, files left in place')
    await datastores.settings.updateAsync({ _id: 'backupFolder' }, { _id: 'backupFolder', value: '' }, { upsert: true })
    state = forFolder(null)
    await saveMemory()
    setStatus({ folder: null, failure: null, writtenAt: null, mergedFrom: null })
  }

  async function quitStep() {
    if (!status.ready || !changed) {
      log(`quit: no write (${!status.ready ? 'not ready' : 'nothing changed'})`)
      return
    }

    const folder = await currentFolder()
    if (folder === null) {
      await savePending()
      return
    }

    log('quit: writing')
    await write(folder)
  }

  // #endregion the steps

  return {
    /**
     * The startup check. The data may load once it resolves. The limit is on
     * the read of the folder, so that a hung network mount cannot hold the
     * data load for good.
     * @param {number} [limit]
     */
    start: (limit = STARTUP_READ_LIMIT_MS) => exclusive(async () => {
      try {
        await startup(limit)
      } catch (error) {
        log(`startup failed: ${errorText(error)}`)
        markReady()
      }
    }),

    /** Resolves once the data may load */
    whenReady: () => readyPromise,

    tick: () => exclusive(tick),

    /**
     * One last write on a real quit, limited so that a hung network folder
     * cannot hold the quit
     * @param {number} [limit]
     */
    quit: (limit = QUIT_LIMIT_MS) => {
      let finished = false
      return Promise.race([
        exclusive(quitStep).catch(() => {}).finally(() => { finished = true }),
        sleep(limit).then(() => {
          if (!finished) { log('quit: the write did not finish in time') }
        }),
      ])
    },

    /** Main's folder dialog has written the setting */
    folderChosen: async () => {
      await exclusive(folderChosenStep)
      return snapshot()
    },

    stop: async () => {
      await exclusive(stopStep)
      return snapshot()
    },

    status: snapshot,

    /**
     * One recorded intent, to go to this machine's segment on the next tick.
     * The sequence number is given at the append, with the state that counts
     * it, so a tick that never ran gives none away.
     * @param {{ at: number, type: string, key: string, data?: Record<string, any> }} event
     */
    recordEvent: ({ at, type, key, data = {} }) => {
      buffered.push({ at, type, key, data })
      changed = true
    },

    /** A datastore the backup covers was written */
    markChanged: () => { changed = true },

    hasChanged: () => changed,

    /** For a test: the log written so far is on disk */
    flushLog: () => logChain,
  }
}
