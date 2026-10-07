import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'

import { BACKUP_SECTIONS } from '../../renderer/helpers/backup'
import { isBaseFileName, lineageEntry, readSyncFile, SYNC_FILE_NAME } from '../../renderer/helpers/keptBackup'
import { MACHINE_BOUND_SETTINGS } from './machineBound'
import { backupsFolder, isRestorableSetting, removeOldSafetyCopies, safetyCopyName } from './restore'

/**
 * The keeper: keeps the app's backup current in a folder Tomas picks, and
 * takes it in when the app starts, so that switching machines needs no export
 * and no restore. Moving the folder between machines is the sync tool's job.
 * The design is `.scratch/auto-sync/spec.md` and ADR-0023.
 *
 * The folder holds a base, a full backup gzipped and named by its hash, and
 * the sync file, which names its base and holds every change since it. Every
 * machine follows the folder: before each write the keeper checks that the
 * sync file is the one it last saw, and when another machine wrote it since,
 * merges that machine's changes into its own data first, against the state
 * both last had, and the open windows load what changed (ADR-0024).
 *
 * Everything it needs comes in as arguments, as for restore.js, so that a test
 * runs several keepers on one temporary folder with a file system that can
 * stop a write at any step. Every decision goes to the keeper log in the data
 * folder, which is what a problem found after days of use is traced with.
 */

export const LOCK_FILE_NAME = 'fjernsyn-sync.lock'
export const TEMP_PREFIX = '.fjernsyn-tmp-'
export const STATE_FILE_NAME = 'keeper-state.json'
export const LOG_FILE_NAME = 'keeper.log'
export const SHARED_SYNC_FILE_NAME = 'keeper-shared.json'
export const SHARED_BASE_FILE_NAME = 'keeper-shared-base.json.gz'

export const TICK_MS = 60_000
export const STALE_LOCK_MS = 2 * 60_000
export const QUIT_LIMIT_MS = 10_000
export const SAFETY_COPY_EVERY_MS = 60 * 60_000
export const RETRY_MS = 1_000
export const RETRIES = 2
export const FOREIGN_TEMP_MS = 24 * 60 * 60_000
export const UNREFERENCED_BASE_MS = 7 * 24 * 60 * 60_000
export const LOG_CAP_BYTES = 1024 * 1024
export const STARTUP_READ_LIMIT_MS = 30_000
const RENAME_TRIES = 5
const RENAME_RETRY_MS = 200

const gunzip = promisify(gunzipCallback)

// #region types

/**
 * @typedef {'overwrite' | 'notNow'} KeeperAnswer
 */

/**
 * @typedef {object} KeeperPause
 * @property {'refused' | 'newer'} reason
 * @property {string} key new for every event, so that a notice asks once per event
 * @property {string | null} machineName who wrote the sync file; null when it does not say
 * @property {number | null} writtenAt the sync file's modified time
 * @property {string | null} detail why a file was refused
 * @property {number | null} formatVersion a newer file's format version
 */

/**
 * @typedef {object} KeeperStatus
 * @property {string | null} folder the backup folder; null when the keeper is off
 * @property {boolean} ready whether the startup check is done
 * @property {number | null} writtenAt when this machine last wrote the sync file
 * @property {{ message: string, since: number } | null} failure while writes fail; `since` is the first failure in the row
 * @property {KeeperPause | null} pause
 * @property {{ machineName: string | null, writtenAt: number | null, since: number } | null} arriving another machine's sync file whose base is not here yet: nothing is written until it comes
 * @property {{ key: string, machineName: string | null, writtenAt: number | null } | null} tookIn another machine's changes merged at this start, for its toast
 * @property {{ machineName: string | null, at: number } | null} mergedFrom the last time another machine's changes were merged while the app ran
 */

/**
 * The keeper's memory, `backups/keeper-state.json` in the data folder
 * @typedef {object} KeeperState
 * @property {string | null} folder the folder the rest was about
 * @property {string | null} lastSeen the hash of the sync file as this machine last wrote or took it in
 * @property {string | null} contentHash the content last written or taken in
 * @property {string | null} pending the hash of a sync file being renamed into place
 * @property {string | null} pendingContent the content of that sync file, made the content hash with it
 * @property {string | null} sharedBase the hash of the base kept beside the shared state's sync file
 */

/**
 * @typedef {object} SyncRead
 * @property {string} text
 * @property {string} hash
 * @property {number} mtime
 */

/**
 * What the folder holds, read
 * @typedef {{ kind: 'none' } |
 *   { kind: 'ok', sync: SyncRead, parsed: any, baseText: string } |
 *   { kind: 'baseMissing', sync: SyncRead, parsed: any } |
 *   { kind: 'refused', sync: SyncRead, parsed: any, detail: string } |
 *   { kind: 'newer', sync: SyncRead, parsed: any }} KeptRead
 */

/**
 * What a merge while the app ran changed, for the windows: the sections to
 * load again, and the history's records themselves, as the whole history is
 * tens of megabytes to load again every minute while another machine plays
 * @typedef {object} DataChanges
 * @property {string[]} sections
 * @property {{ put: Record<string, any>[], removed: string[] } | null} history the entries put whole, and the videos whose entries went
 */

// #endregion types

/**
 * Wraps the writing methods of the datastores the backup holds, so that a
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

/**
 * @param {object} deps
 * @param {Record<string, any>} deps.datastores the eight the backup holds, by section name
 * @param {string} deps.dataFolder
 * @param {string} deps.appVersion
 * @param {string | (() => Promise<string>)} deps.installationId
 * @param {string | null} deps.machineName
 * @param {(job: object) => Promise<any>} deps.runJob the worker's, or the job run inline
 * @param {(status: KeeperStatus) => void} [deps.onStatus]
 * @param {(changes: DataChanges) => void} [deps.onDataChanged] a merge while the app ran changed these sections in the datastores
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
  runJob,
  onStatus = () => {},
  onDataChanged = () => {},
  fileSystem = fs,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  makeToken = () => randomBytes(8).toString('hex'),
}) {
  /** @type {string} */
  let installationId = typeof installationIdSource === 'string' ? installationIdSource : ''

  /** @type {KeeperState} */
  let state = emptyState(null)

  /** @type {KeeperStatus} */
  let status = {
    folder: null,
    ready: false,
    writtenAt: null,
    failure: null,
    pause: null,
    arriving: null,
    tookIn: null,
    mergedFrom: null,
  }

  /** Raised by every write to a datastore the backup holds */
  let changed = true

  /**
   * Overwrite was chosen over the sync file with this hash (null: none was
   * there): a write goes ahead over that file, and only that one, whoever
   * wrote it. Undefined when not overwriting.
   * @type {string | null | undefined}
   */
  let overwriteHash

  /** The hash of the sync file the pause is about */
  let pausedOn = null

  /** When the last safety copy was written, as a merge while running writes one at most hourly */
  let lastSafetyCopyAt = -Infinity

  /** The base last read or written, unpacked and as in the folder */
  /** @type {{ file: string, sha256: string, text: string, packed: Uint8Array } | null} */
  let baseCache = null

  /** The token of the lock this keeper holds, while it holds one */
  let heldToken = null

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

  /**
   * @param {KeeperPause['reason']} reason
   * @param {SyncRead | null} sync
   * @param {object} [extra]
   * @param {any} [extra.parsed] the sync file as read, for who wrote it
   * @param {string | null} [extra.detail]
   * @param {number | null} [extra.formatVersion]
   */
  function pause(reason, sync, { parsed = null, detail = null, formatVersion = null } = {}) {
    pausedOn = sync?.hash ?? null
    overwriteHash = undefined

    const pauseStatus = {
      reason,
      key: `${reason}:${sync?.hash ?? 'none'}`,
      machineName: parsed?.ok ? parsed.header.machineName : null,
      writtenAt: sync?.mtime ?? null,
      detail,
      formatVersion,
    }

    log(`paused: ${reason}${detail ? ` (${detail})` : ''}, sync file ${short(sync?.hash)} by ${pauseStatus.machineName ?? 'an unknown machine'}`)
    setStatus({ pause: pauseStatus })
  }

  function resume() {
    pausedOn = null
    setStatus({ pause: null })
  }

  /**
   * The sync file in the folder is the one this keeper was renaming into
   * place when it stopped: its own, now last seen, with the content it held
   */
  function adoptPending() {
    log(`sync file ${short(state.pending)} is the pending one: now last seen`)
    state.lastSeen = state.pending
    state.contentHash = state.pendingContent ?? state.contentHash
    state.pending = null
    state.pendingContent = null
  }

  // #endregion status and log

  // #region state file

  /** @param {string | null} folder */
  function emptyState(folder) {
    return { folder, lastSeen: null, contentHash: null, pending: null, pendingContent: null, sharedBase: null }
  }

  async function loadState() {
    try {
      const text = await fileSystem.readFile(path.join(backupsFolder(dataFolder), STATE_FILE_NAME), 'utf8')
      const read = JSON.parse(text)
      const field = name => typeof read?.[name] === 'string' ? read[name] : null

      return { folder: field('folder'), lastSeen: field('lastSeen'), contentHash: field('contentHash'), pending: field('pending'), pendingContent: field('pendingContent'), sharedBase: field('sharedBase') }
    } catch (error) {
      if (!isMissing(error)) {
        log(`state file unreadable, starting afresh: ${errorText(error)}`)
      }
      return emptyState(null)
    }
  }

  async function saveState() {
    const folder = backupsFolder(dataFolder)
    await fileSystem.mkdir(folder, { recursive: true })
    await writeAtomic(folder, STATE_FILE_NAME, JSON.stringify(state, null, 2) + '\n')
  }

  /**
   * The backup folder the setting names. A folder other than the one the
   * state is about means last seen is unknown.
   * @returns {Promise<string | null>}
   */
  async function currentFolder() {
    const setting = await datastores.settings.findOneAsync({ _id: 'backupFolder' })
    const folder = typeof setting?.value === 'string' && setting.value !== '' ? setting.value : null

    if (folder !== state.folder) {
      log(`folder is now ${folder ?? 'not set'}; last seen forgotten`)
      state = emptyState(folder)
      await saveState()
    }

    if (status.folder !== folder) {
      setStatus({ folder })
    }

    return folder
  }

  // #endregion state file

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
   * @param {string} folder
   * @returns {Promise<SyncRead | null>}
   */
  async function readSync(folder) {
    const file = path.join(folder, SYNC_FILE_NAME)

    let text
    try {
      text = await fileSystem.readFile(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) { return null }
      throw error
    }

    let mtime = null
    try {
      mtime = (await fileSystem.stat(file)).mtimeMs
    } catch {}

    return { text, hash: sha256(text), mtime }
  }

  /**
   * A base, unpacked and its hash checked
   * @param {string} folder
   * @param {{ file: string, sha256: string }} reference
   * @returns {Promise<{ text: string } | { problem: 'missing' | 'baseUnreadable' | 'baseMismatch' }>}
   */
  async function readBase(folder, reference) {
    // Only while the file is still in the folder: a sync file built on a base
    // that is gone would name a base no other machine can read
    if (baseCache?.sha256 === reference.sha256 &&
      await fileSystem.stat(path.join(folder, reference.file)).then(() => true, () => false)) {
      return { text: baseCache.text }
    }

    let packed
    try {
      packed = await fileSystem.readFile(path.join(folder, reference.file))
    } catch (error) {
      // A file that cannot be opened (held by a sync tool, online only and
      // the network down) is as good as not here yet: looked for again,
      // never refused with Overwrite offered
      if (!isMissing(error)) {
        log(`base ${reference.file} could not be read: ${errorText(error)}`)
      }
      return { problem: 'missing' }
    }

    let text
    try {
      text = (await gunzip(packed)).toString('utf8')
    } catch {
      return { problem: 'baseUnreadable' }
    }

    if (sha256(text) !== reference.sha256) {
      return { problem: 'baseMismatch' }
    }

    baseCache = { file: reference.file, sha256: reference.sha256, text, packed }
    return { text }
  }

  /**
   * The sync file and its base. An unreadable file is read again twice, a
   * second apart, as a sync tool may hold it while it writes. A missing base
   * makes it read the sync file once more, as a writer may have replaced the
   * pair between the two reads.
   * @param {string} folder
   * @param {{ retry?: boolean }} [options]
   * @returns {Promise<KeptRead>}
   */
  async function readKept(folder, { retry = true } = {}) {
    let failures = 0
    let readAgainForBase = false

    for (;;) {
      let sync
      try {
        sync = await readSync(folder)
      } catch (error) {
        if (!retry || failures >= RETRIES) { throw error }

        failures++
        log(`sync file could not be read (${errorText(error)}), reading again in a second`)
        await sleep(RETRY_MS)
        continue
      }

      if (sync === null) {
        return { kind: 'none' }
      }

      const parsed = readSyncFile(sync.text)

      if (!parsed.ok && parsed.reason === 'newerVersion') {
        return { kind: 'newer', sync, parsed }
      }

      /** @type {string | null} */
      let problem = parsed.ok ? null : parsed.reason
      let baseText = null

      if (parsed.ok) {
        const base = await readBase(folder, parsed.base)

        if ('text' in base) {
          baseText = base.text
        } else if (base.problem === 'missing') {
          if (!readAgainForBase) {
            readAgainForBase = true
            continue
          }

          log(`base ${parsed.base.file} of sync file ${short(sync.hash)} not in the folder`)
          return { kind: 'baseMissing', sync, parsed }
        } else {
          problem = base.problem
        }
      }

      if (problem === null) {
        return { kind: 'ok', sync, parsed, baseText }
      }

      if (retry && failures < RETRIES) {
        failures++
        log(`sync file ${short(sync.hash)} unreadable (${problem}), reading again in a second`)
        await sleep(RETRY_MS)
        continue
      }

      return { kind: 'refused', sync, parsed, detail: problem }
    }
  }

  /**
   * @param {string} folder
   * @returns {Promise<{ exists: false } | { exists: true, fresh: boolean, token: string | null, machineName: string | null }>}
   */
  async function readLock(folder) {
    const file = path.join(folder, LOCK_FILE_NAME)

    let stat
    let text
    try {
      stat = await fileSystem.stat(file)
      text = await fileSystem.readFile(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) { return { exists: false } }
      throw error
    }

    let body = null
    try {
      body = JSON.parse(text)
    } catch {}

    return {
      exists: true,
      fresh: now() - stat.mtimeMs < STALE_LOCK_MS,
      token: typeof body?.token === 'string' ? body.token : null,
      machineName: typeof body?.machineName === 'string' ? body.machineName : null,
    }
  }

  /**
   * Made with an exclusive create; a lock older than two minutes was left by
   * a write that failed and is overwritten. Read back either way, as two
   * keepers taking over one stale lock would otherwise both believe they hold it.
   * @param {string} folder
   * @returns {Promise<string | null>} the token, or null when another holds the lock
   */
  async function takeLock(folder) {
    const file = path.join(folder, LOCK_FILE_NAME)
    const token = makeToken()
    const body = JSON.stringify({ token, installationId, machineName, time: new Date(now()).toISOString() })

    try {
      await fileSystem.writeFile(file, body, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (error?.code !== 'EEXIST') { throw error }

      const lock = await readLock(folder)
      if (lock.exists && lock.fresh) {
        log(`lock held by ${lock.machineName ?? 'an unknown machine'}; not writing`)
        return null
      }

      log(`stale lock${lock.exists ? ` of ${lock.machineName ?? 'an unknown machine'}` : ''} taken over`)
      await fileSystem.writeFile(file, body, 'utf8')
    }

    const back = await readLock(folder)
    if (!back.exists || back.token !== token) {
      log('lock lost to another keeper; not writing')
      return null
    }

    heldToken = token
    return token
  }

  /**
   * @param {string} folder
   * @param {string} token
   */
  async function releaseLock(folder, token) {
    heldToken = null

    try {
      const lock = await readLock(folder)
      if (lock.exists && lock.token === token) {
        await fileSystem.rm(path.join(folder, LOCK_FILE_NAME), { force: true })
      } else {
        // Taken over while this keeper wrote: another may have written too
        log(lock.exists ? `lock now held by ${lock.machineName ?? 'an unknown machine'}; left in place` : 'lock already gone')
      }
    } catch (error) {
      log(`could not remove the lock: ${errorText(error)}`)
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
   * After a rebase: the base the replaced sync file pointed to goes at once;
   * another that nothing points to only when more than seven days old, as it
   * may be one the other machine has just written, its sync file on the way.
   * @param {string} folder
   * @param {string} current the base the sync file now points to
   * @param {string | null} replaced the base the replaced sync file pointed to
   */
  async function removeOldBases(folder, current, replaced) {
    let names
    try {
      names = await fileSystem.readdir(folder)
    } catch {
      return
    }

    for (const name of names) {
      if (!isBaseFileName(name) || name === current) { continue }

      try {
        if (name !== replaced) {
          const { mtimeMs } = await fileSystem.stat(path.join(folder, name))
          if (now() - mtimeMs <= UNREFERENCED_BASE_MS) { continue }
        }

        await fileSystem.rm(path.join(folder, name), { force: true })
        log(`removed old base ${name}`)
      } catch (error) {
        log(`could not remove base ${name}: ${errorText(error)}`)
      }
    }
  }

  // #endregion files

  // #region collecting

  /**
   * Every section as the datastores hold it. Settings are every stored one
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

    return sections
  }

  // #endregion collecting

  // #region the shared state

  /**
   * The shared state is the last seen sync file's: the one both machines last
   * had, when the other machine's next file builds on it. Kept in the data
   * folder as the sync file's text and a copy of its base, so that a merge
   * can tell what each side changed since, whatever has become of the folder.
   * @param {string} syncText
   * @param {{ sha256: string, packed: Uint8Array } | null} base the base it names, packed as in the folder
   */
  async function rememberShared(syncText, base) {
    const folder = backupsFolder(dataFolder)

    try {
      await fileSystem.mkdir(folder, { recursive: true })

      if (base !== null && state.sharedBase !== base.sha256) {
        await writeAtomic(folder, SHARED_BASE_FILE_NAME, base.packed)
        state.sharedBase = base.sha256
      }

      await writeAtomic(folder, SHARED_SYNC_FILE_NAME, syncText)
    } catch (error) {
      // Only the next merge is the poorer for it: a union, with no removals
      log(`could not keep the shared state: ${errorText(error)}`)
    }
  }

  /**
   * @returns {Promise<{ syncText: string, baseText: string } | null>} null when it is not known
   */
  async function loadShared() {
    if (state.lastSeen === null) { return null }

    const folder = backupsFolder(dataFolder)

    try {
      const syncText = await fileSystem.readFile(path.join(folder, SHARED_SYNC_FILE_NAME), 'utf8')
      if (sha256(syncText) !== state.lastSeen) { return null }

      const parsed = readSyncFile(syncText)
      if (!parsed.ok) { return null }

      if (baseCache?.sha256 === parsed.base.sha256) {
        return { syncText, baseText: baseCache.text }
      }

      const baseText = (await gunzip(await fileSystem.readFile(path.join(folder, SHARED_BASE_FILE_NAME)))).toString('utf8')
      if (sha256(baseText) !== parsed.base.sha256) { return null }

      return { syncText, baseText }
    } catch {
      return null
    }
  }

  /**
   * The sync files a state builds on, newest first, once it is written over
   * the sync file with this text and hash
   * @param {string} syncText
   * @param {string} hash
   */
  function lineageAfter(syncText, hash) {
    const parsed = readSyncFile(syncText)
    return [lineageEntry(hash), ...(parsed.ok ? parsed.header.lineage : [])]
  }

  /** The lineage of this machine's state when the folder no longer shows last seen */
  async function lineageOfLastSeen() {
    if (state.lastSeen === null) { return [] }

    try {
      const syncText = await fileSystem.readFile(path.join(backupsFolder(dataFolder), SHARED_SYNC_FILE_NAME), 'utf8')
      if (sha256(syncText) === state.lastSeen) {
        return lineageAfter(syncText, state.lastSeen)
      }
    } catch {}

    return [lineageEntry(state.lastSeen)]
  }

  // #endregion the shared state

  // #region merging

  /**
   * Puts and removes records in this machine's datastores, one by one, so
   * that a merge appends only what changed. A setting is never removed, and
   * one only main may set is never written.
   * @param {Record<string, { put: Record<string, any>[], remove: string[] }>} toApply
   */
  async function applyToDatastores(toApply) {
    for (const [section, { put, remove }] of Object.entries(toApply)) {
      const datastore = datastores[section]

      // Removals first: a history entry may come back under another _id
      if (section !== 'settings') {
        await Promise.all(remove.map(_id => datastore.removeAsync({ _id }, {})))
      }

      const records = section === 'settings'
        ? put.filter(({ _id, value }) => !MACHINE_BOUND_SETTINGS.has(_id) && isRestorableSetting(_id, value))
        : put

      await Promise.all(records.map(record => datastore.updateAsync({ _id: record._id }, record, { upsert: true })))
    }
  }

  /**
   * @param {string} text
   */
  async function writeSafetyCopy(text) {
    const folder = backupsFolder(dataFolder)
    const name = safetyCopyName(new Date(now()))

    await fileSystem.mkdir(folder, { recursive: true })

    try {
      await fileSystem.writeFile(path.join(folder, name), text, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      // One already written this second is as good
      if (error?.code !== 'EEXIST') { throw error }
    }

    await removeOldSafetyCopies(folder, fileSystem)
    lastSafetyCopyAt = now()
    return name
  }

  /**
   * Another machine wrote the folder: its changes are merged into this
   * machine's data, against the shared state when both last had it, and the
   * open windows load what changed. Last seen moves only once every change
   * is in, so a merge cut short is merged again.
   * @param {Extract<KeptRead, { kind: 'ok' }>} kept
   * @param {{ atStartup: boolean }} options
   * @returns {Promise<boolean>} whether it merged; false when it paused instead
   */
  async function mergeFrom(kept, { atStartup }) {
    const started = now()
    const writer = kept.parsed.header.machineName ?? 'an unknown machine'

    // Their file builds on what this machine last saw only when it says so;
    // a write of ours they never saw (the sync tool kept theirs) is no
    // ancestor, and merging against it would undo our own last changes
    const shared = await loadShared()
    const known = shared !== null && kept.parsed.header.lineage.includes(lineageEntry(state.lastSeen))

    const ours = await collect()
    // Which video each of this machine's entries is, for a window to remove it by
    const ourVideos = new Map(ours.history.map(record => [record._id, record.videoId]))

    const result = await runJob({
      type: 'merge',
      theirs: { syncText: kept.sync.text, baseText: kept.baseText },
      ancestor: known ? shared : null,
      sections: ours,
      header: header(),
      machineBound: [...MACHINE_BOUND_SETTINGS],
      wantSafetyCopy: atStartup || now() - lastSafetyCopyAt >= SAFETY_COPY_EVERY_MS,
    })

    if (!result.ok) {
      pause('refused', kept.sync, { parsed: kept.parsed, detail: result.reason })
      return false
    }

    const safetyCopy = result.safetyCopy === null ? null : await writeSafetyCopy(result.safetyCopy)

    await applyToDatastores(result.toApply)

    await rememberShared(kept.sync.text, baseCache)
    state.lastSeen = kept.sync.hash
    state.pending = null
    state.pendingContent = null
    state.contentHash = result.theirContentHash
    await saveState()

    // This installation's own file, met with last seen forgotten (the folder
    // chosen again): it is what this machine last wrote, as at startup
    if (kept.parsed.header.installationId === installationId) {
      setStatus({ writtenAt: kept.sync.mtime })
    }

    const sections = Object.keys(result.toApply)
    const counts = sections.map(name => `${name} +${result.toApply[name].put.length} -${result.toApply[name].remove.length}`).join(', ')

    log(`merged sync file ${short(kept.sync.hash)} by ${writer} ${known ? 'against the shared state' : 'with the shared state unknown, as a union'}: ${counts || 'nothing to change here'}, ${result.conflicts} conflicts${safetyCopy ? `, safety copy ${safetyCopy}` : ''}, ${now() - started} ms`)

    if (sections.length > 0) {
      if (atStartup) {
        setStatus({ tookIn: { key: kept.sync.hash, machineName: kept.parsed.header.machineName, writtenAt: kept.sync.mtime } })
      } else {
        onDataChanged({ sections, history: historyChanges(result.toApply.history, ourVideos) })
        setStatus({ mergedFrom: { machineName: kept.parsed.header.machineName, at: now() } })
      }
    }

    awaitedHash = null
    if (status.arriving !== null) {
      setStatus({ arriving: null })
    }

    // What this machine adds to theirs is written by the same tick
    changed = true
    return true
  }

  /**
   * @param {{ put: Record<string, any>[], remove: string[] } | undefined} changes
   * @param {Map<string, string>} ourVideos
   * @returns {DataChanges['history']}
   */
  function historyChanges(changes, ourVideos) {
    if (changes === undefined) { return null }

    // An entry put back under another _id is put, not removed
    const put = new Set(changes.put.map(record => record.videoId))
    const removed = changes.remove.map(_id => ourVideos.get(_id)).filter(videoId => typeof videoId === 'string' && !put.has(videoId))

    return { put: changes.put, removed }
  }

  /** The hash of the sync file whose base has not come */
  let awaitedHash = null

  /**
   * Another machine's sync file is here and its base is not: nothing is
   * written over it until the base comes, and the tick looks again
   * @param {Extract<KeptRead, { kind: 'baseMissing' }>} kept
   */
  function awaitBase(kept) {
    if (awaitedHash === kept.sync.hash) { return }

    awaitedHash = kept.sync.hash
    log(`waiting for base ${kept.parsed.base.file} of sync file ${short(kept.sync.hash)} by ${kept.parsed.header.machineName ?? 'an unknown machine'}; writing nothing until it comes`)
    setStatus({ arriving: { machineName: kept.parsed.header.machineName, writtenAt: kept.sync.mtime, since: status.arriving?.since ?? now() } })
  }

  /**
   * Pauses on a folder that cannot be merged or written over
   * @param {Extract<KeptRead, { kind: 'refused' | 'newer' }>} kept
   */
  function pauseFor(kept) {
    if (kept.kind === 'refused') {
      pause('refused', kept.sync, { parsed: kept.parsed, detail: kept.detail })
    } else {
      pause('newer', kept.sync, { formatVersion: kept.parsed.formatVersion })
    }
  }

  /**
   * What the folder holds, acted on: merged, awaited, or paused on. Returns
   * the sync file now last seen, or null when nothing should be written.
   * @param {KeptRead} kept
   * @param {{ atStartup: boolean }} options
   * @returns {Promise<SyncRead | null | 'none'>}
   */
  async function takeInWhatIsThere(kept, { atStartup }) {
    switch (kept.kind) {
      case 'none':
        return 'none'
      case 'baseMissing':
        awaitBase(kept)
        return null
      case 'refused':
      case 'newer':
        pauseFor(kept)
        return null
      case 'ok':
        return await mergeFrom(kept, { atStartup }) ? kept.sync : null
    }

    return null
  }

  // #endregion merging

  // #region writing

  /**
   * The tick's steps from the lock on: another machine's sync file merged
   * first, then this machine's state written when it changed. Returns
   * without writing when another keeper holds the lock, while a base is
   * awaited, or when nothing changed.
   * @param {string} folder
   */
  async function write(folder) {
    try {
      const lock = await readLock(folder)
      if (lock.exists && lock.fresh && lock.token !== heldToken) {
        log(`lock held by ${lock.machineName ?? 'an unknown machine'}; skipping this tick`)
        return
      }

      let sync = await readSync(folder)

      // Overwrite goes over the file it was chosen for, and no newer one
      const overwrite = overwriteHash !== undefined && (sync?.hash ?? null) === overwriteHash

      if (sync !== null && !overwrite) {
        if (sync.hash === state.pending) {
          adoptPending()
          await saveState()
        } else if (sync.hash !== state.lastSeen) {
          const after = await takeInWhatIsThere(await readKept(folder), { atStartup: false })
          if (after === null) { return }
          sync = after === 'none' ? null : after
        }
      }

      if (awaitedHash !== null && !overwrite) {
        awaitedHash = null
        setStatus({ arriving: null })
      }

      const current = sync !== null && sync.hash === state.lastSeen && !overwrite

      if (!changed && current) {
        return
      }

      // The base to build on: the one the sync file names, when it reads
      let base = null
      let replacedBase = null
      if (sync !== null) {
        const parsed = readSyncFile(sync.text)
        if (parsed.ok) {
          replacedBase = parsed.base.file
          const read = await readBase(folder, parsed.base)

          if ('text' in read) {
            base = { file: parsed.base.file, sha256: parsed.base.sha256, text: read.text }
          } else {
            log(`base ${parsed.base.file} ${read.problem}: rebasing`)
          }
        }
      }

      // Lowered before collecting, so that a write while building raises it again
      changed = false

      const started = now()
      const sections = await collect()
      const result = await runJob({
        type: 'build',
        sections,
        header: header(),
        lineage: current ? lineageAfter(sync.text, sync.hash) : await lineageOfLastSeen(),
        base,
        lastContentHash: current ? state.contentHash : null,
      })

      if (result.unchanged) {
        log(`content unchanged (${short(result.contentHash)}), ${now() - started} ms`)
        return
      }

      const token = await takeLock(folder)
      if (token === null) {
        changed = true
        return
      }

      try {
        // Another keeper may have written between the read and the lock
        const again = await readSync(folder)
        if ((again?.hash ?? null) !== (sync?.hash ?? null)) {
          log('sync file changed while building; trying again next tick')
          changed = true
          return
        }

        if (result.newBase !== null) {
          await writeAtomic(folder, result.newBase.file, result.newBase.gz)
          log(`rebase: wrote base ${result.newBase.file}`)
        }

        state.pending = result.syncHash
        state.pendingContent = result.contentHash
        await saveState()

        await writeAtomic(folder, SYNC_FILE_NAME, result.syncText)

        if (result.newBase !== null) {
          baseCache = { file: result.newBase.file, sha256: result.newBase.sha256, text: result.newBase.text, packed: result.newBase.gz }
        }

        await rememberShared(result.syncText, baseCache?.sha256 === readSyncFile(result.syncText).base?.sha256 ? baseCache : null)

        state.lastSeen = result.syncHash
        state.pending = null
        state.pendingContent = null
        state.contentHash = result.contentHash
        await saveState()
      } finally {
        await releaseLock(folder, token)
      }

      if (result.newBase !== null) {
        await removeOldBases(folder, result.newBase.file, replacedBase)
        await removeTemporaryFiles(folder, { own: false })
      }

      overwriteHash = undefined

      const counts = Object.entries(sections).map(([name, records]) => `${name} ${records.length}`).join(', ')
      log(`wrote sync file ${short(result.syncHash)} (${result.syncText.length} chars${result.newBase ? `, new base ${result.newBase.file}` : ''}), content ${short(result.contentHash)}, ${counts}, ${now() - started} ms`)
      setStatus({ writtenAt: now(), failure: null })
    } catch (error) {
      changed = true
      const message = errorText(error)
      log(`couldn't write: ${message}`)
      setStatus({ failure: { message, since: status.failure?.since ?? now() } })
    }
  }

  // #endregion writing

  // #region the steps

  async function startup() {
    if (typeof installationIdSource === 'function') {
      installationId = await installationIdSource()
    }

    state = await loadState()

    const folder = await currentFolder()
    if (folder === null) {
      log('startup: no folder set')
      markReady()
      return
    }

    log(`startup: folder ${folder}, last seen ${short(state.lastSeen)}, machine ${machineName ?? '-'}`)

    await removeTemporaryFiles(folder, { own: true })
    // The state file is written the same way, in the data folder
    await removeTemporaryFiles(backupsFolder(dataFolder), { own: true })

    const lock = await readLock(folder)
    const freshLock = lock.exists && lock.fresh

    if (freshLock) {
      log(`startup: a fresh lock by ${lock.machineName ?? 'an unknown machine'}`)
    }

    // A folder that hangs (a network mount, a file online only while the
    // network is down) must not hold the start screen up for good
    let timer
    const kept = await Promise.race([
      readKept(folder, { retry: !freshLock }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), STARTUP_READ_LIMIT_MS)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)

    if (kept === null) {
      log(`startup: the folder did not answer in ${STARTUP_READ_LIMIT_MS / 1000} s; going on without a take in`)
      setStatus({ failure: { message: 'The backup folder did not answer at startup', since: now() } })
    } else if (kept.kind === 'none') {
      log('no sync file: the first tick writes one')
    } else if (freshLock && kept.kind !== 'ok') {
      log(`a fresh lock, and the folder does not read cleanly (${kept.kind}): nothing taken in`)
    } else if (kept.sync.hash === state.lastSeen) {
      log(`sync file ${short(kept.sync.hash)} is last seen: nothing to take in`)
      if (kept.parsed?.ok && kept.parsed.header.installationId === installationId) {
        setStatus({ writtenAt: kept.sync.mtime })
      }
    } else if (kept.sync.hash === state.pending) {
      adoptPending()
      await saveState()
      setStatus({ writtenAt: kept.sync.mtime })
    } else {
      await takeInWhatIsThere(kept, { atStartup: true })
    }

    markReady()
  }

  /**
   * While paused the tick only reads: a file that reads again, or is last
   * seen again, resumes, and the next tick merges it; a newer refusal
   * updates the notice.
   * @param {string} folder
   */
  async function look(folder) {
    const kept = await readKept(folder, { retry: false })
    if (kept.kind === 'none') { return }

    if (kept.sync.hash === state.lastSeen || kept.kind === 'ok' || kept.kind === 'baseMissing') {
      log(`sync file ${short(kept.sync.hash)} reads again: resuming`)
      resume()
      return
    }

    if (kept.sync.hash !== pausedOn || kept.kind !== status.pause.reason) {
      pauseFor(kept)
    }
  }

  async function tick() {
    if (!status.ready) { return }

    const folder = await currentFolder()
    if (folder === null) { return }

    if (status.pause !== null) {
      await look(folder)
      return
    }

    await write(folder)
  }

  /** @param {KeeperAnswer} answer */
  async function answerStep(answer) {
    log(`answer: ${answer}`)

    const folder = await currentFolder()
    if (folder === null) { return }

    if (answer !== 'overwrite') { return }

    // Over a file that cannot be read, or one whose base never came
    if ((status.pause === null || status.pause.reason === 'newer') && status.arriving === null) { return }

    resume()
    awaitedHash = null
    setStatus({ arriving: null })
    overwriteHash = (await readSync(folder))?.hash ?? null
    changed = true
    await write(folder)
  }

  async function folderChosenStep() {
    const folder = await currentFolder()
    // Chosen again or anew, last seen starts unknown: what is there is merged as a union
    state = emptyState(folder)
    await saveState()

    setStatus({ pause: null, failure: null, writtenAt: null, arriving: null })
    pausedOn = null
    awaitedHash = null

    if (folder === null) { return }

    log(`folder chosen: ${folder}`)
    changed = true
    await write(folder)
  }

  async function stopStep() {
    log('stop keeping: setting cleared, files left in place')
    await datastores.settings.updateAsync({ _id: 'backupFolder' }, { _id: 'backupFolder', value: '' }, { upsert: true })
    state = emptyState(null)
    await saveState()
    pausedOn = null
    awaitedHash = null
    overwriteHash = undefined
    setStatus({ folder: null, pause: null, failure: null, writtenAt: null, arriving: null, mergedFrom: null })
  }

  async function quitStep() {
    if (!status.ready || status.pause !== null || !changed) {
      log(`quit: no write (${!status.ready ? 'not ready' : status.pause !== null ? 'paused' : 'nothing changed'})`)
      return
    }

    const folder = await currentFolder()
    if (folder === null) { return }

    log('quit: writing')
    await write(folder)
  }

  // #endregion the steps

  return {
    /** The startup check, a merge included; the data may load once it resolves */
    start: () => exclusive(async () => {
      try {
        await startup()
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

    /** @param {KeeperAnswer} answer */
    answer: async (answer) => {
      await exclusive(() => answerStep(answer))
      return snapshot()
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

    /** A datastore the backup holds was written */
    markChanged: () => { changed = true },

    hasChanged: () => changed,

    /** For a test: the log written so far is on disk */
    flushLog: () => logChain,
  }
}
