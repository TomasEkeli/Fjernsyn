import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'

import { BACKUP_SECTIONS } from '../../renderer/helpers/backup'
import { isBaseFileName, readSyncFile, SYNC_FILE_NAME } from '../../renderer/helpers/keptBackup'
import { MACHINE_BOUND_SETTINGS } from './machineBound'
import { backupsFolder, restoreBackup } from './restore'

/**
 * The keeper: keeps the app's backup current in a folder Tomas picks, and
 * takes it in when the app starts, so that switching machines needs no export
 * and no restore. Moving the folder between machines is the sync tool's job.
 * The design is `.scratch/auto-sync/spec.md` and ADR-0023.
 *
 * The folder holds a base, a full backup gzipped and named by its hash, and
 * the sync file, which names its base and holds every change since it. One
 * machine writes at a time: before each write the keeper checks that the sync
 * file is the one it last saw, and when another machine wrote it since, it
 * stops writing and asks.
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

export const TICK_MS = 60_000
export const STALE_LOCK_MS = 2 * 60_000
export const QUIT_LIMIT_MS = 10_000
export const LOOK_AGAIN_MS = 10_000
export const RETRY_MS = 1_000
export const RETRIES = 2
export const FOREIGN_TEMP_MS = 24 * 60 * 60_000
export const UNREFERENCED_BASE_MS = 7 * 24 * 60 * 60_000
export const LOG_CAP_BYTES = 1024 * 1024

const gunzip = promisify(gunzipCallback)

// #region types

/**
 * @typedef {'restore' | 'overwrite' | 'notNow' | 'wait' | 'continue' | 'stopWaiting'} KeeperAnswer
 */

/**
 * @typedef {object} KeeperPause
 * @property {'otherMachine' | 'refused' | 'newer' | 'baseMissing'} reason
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
 * @property {{ machineName: string | null, writtenAt: number | null, waitingSince: number | null } | null} arriving at startup, another machine's sync file whose base is not here yet
 * @property {{ key: string, machineName: string | null, writtenAt: number | null } | null} tookIn the take in at this start, for its toast
 */

/**
 * The keeper's memory, `backups/keeper-state.json` in the data folder
 * @typedef {object} KeeperState
 * @property {string | null} folder the folder the rest was about
 * @property {string | null} lastSeen the hash of the sync file as this machine last wrote or took it in
 * @property {string | null} contentHash the content last written or taken in
 * @property {string | null} pending the hash of a sync file being renamed into place
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
 * @param {() => void} deps.relaunch
 * @param {(status: KeeperStatus) => void} [deps.onStatus]
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
  relaunch,
  onStatus = () => {},
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
  }

  /** Raised by every write to a datastore the backup holds */
  let changed = true

  /** Overwrite was chosen: the next write goes ahead whoever wrote the sync file */
  let overwriting = false

  /** The hash of the sync file the pause is about */
  let pausedOn = null

  /** Set once a restore is under way, so that nothing writes before the relaunch */
  let relaunching = false

  /** @type {{ file: string, sha256: string, text: string } | null} */
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
        await fileSystem.rename(file, `${file}.1`)
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
    overwriting = false

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

  // #endregion status and log

  // #region state file

  /** @param {string | null} folder */
  function emptyState(folder) {
    return { folder, lastSeen: null, contentHash: null, pending: null }
  }

  async function loadState() {
    try {
      const text = await fileSystem.readFile(path.join(backupsFolder(dataFolder), STATE_FILE_NAME), 'utf8')
      const read = JSON.parse(text)
      const field = name => typeof read?.[name] === 'string' ? read[name] : null

      return { folder: field('folder'), lastSeen: field('lastSeen'), contentHash: field('contentHash'), pending: field('pending') }
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

    try {
      await fileSystem.rename(temporary, path.join(folder, name))
    } catch (error) {
      await fileSystem.rm(temporary, { force: true }).catch(() => {})
      throw error
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
    if (baseCache?.sha256 === reference.sha256) {
      return { text: baseCache.text }
    }

    let packed
    try {
      packed = await fileSystem.readFile(path.join(folder, reference.file))
    } catch (error) {
      return { problem: isMissing(error) ? 'missing' : 'baseUnreadable' }
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

    baseCache = { file: reference.file, sha256: reference.sha256, text }
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
      const sync = await readSync(folder)
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

  // #region writing

  /**
   * The tick's steps from the lock on (spec, "The tick"). Returns without
   * writing when another keeper holds the lock, when another machine wrote
   * the sync file (pausing), or when nothing changed.
   * @param {string} folder
   */
  async function write(folder) {
    try {
      const lock = await readLock(folder)
      if (lock.exists && lock.fresh && lock.token !== heldToken) {
        log(`lock held by ${lock.machineName ?? 'an unknown machine'}; skipping this tick`)
        return
      }

      const sync = await readSync(folder)

      if (sync !== null && !overwriting) {
        if (sync.hash === state.pending) {
          log(`sync file ${short(sync.hash)} is the pending one: now last seen`)
          state.lastSeen = sync.hash
          state.pending = null
          await saveState()
        } else if (sync.hash !== state.lastSeen) {
          pause('otherMachine', sync, { parsed: readSyncFile(sync.text) })
          return
        }
      }

      const current = sync !== null && sync.hash === state.lastSeen && !overwriting

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
        await saveState()

        await writeAtomic(folder, SYNC_FILE_NAME, result.syncText)

        state.lastSeen = result.syncHash
        state.pending = null
        state.contentHash = result.contentHash
        await saveState()
      } finally {
        await releaseLock(folder, token)
      }

      if (result.newBase !== null) {
        baseCache = { file: result.newBase.file, sha256: result.newBase.sha256, text: result.newBase.text }
        await removeOldBases(folder, result.newBase.file, replacedBase)
        await removeTemporaryFiles(folder, { own: false })
      }

      overwriting = false

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

  // #region taking in

  /**
   * Safety copy, then each section replaced. Last seen moves only once every
   * section is, so a take in cut short is taken in again at the next start.
   * @param {Extract<KeptRead, { kind: 'ok' }>} kept
   * @returns {Promise<'same' | 'tookIn' | 'failed'>}
   */
  async function takeIn(kept) {
    const started = now()
    const prepared = await runJob({
      type: 'prepareTakeIn',
      syncText: kept.sync.text,
      baseText: kept.baseText,
      sections: await collect(),
      header: header(),
      machineBound: [...MACHINE_BOUND_SETTINGS],
    })

    if (!prepared.ok) {
      pause('refused', kept.sync, { parsed: kept.parsed, detail: prepared.reason })
      return 'failed'
    }

    const writer = kept.parsed.header.machineName ?? 'an unknown machine'

    if (prepared.keptContentHash === prepared.localContentHash) {
      log(`sync file ${short(kept.sync.hash)} by ${writer} has the same content as here: nothing to take in`)
      state.lastSeen = kept.sync.hash
      state.pending = null
      state.contentHash = prepared.keptContentHash
      await saveState()
      return 'same'
    }

    const result = await restoreBackup({
      datastores,
      dataFolder,
      relaunch: () => {},
      now: () => new Date(now()),
      fileSystem,
    }, { safetyCopy: prepared.safetyCopy, sections: prepared.restoreSections })

    if (!result.ok) {
      log(`take in of sync file ${short(kept.sync.hash)} failed: ${result.error}${result.safetyCopyPath ? `; safety copy ${path.basename(result.safetyCopyPath)}` : ''}`)
      pause('otherMachine', kept.sync, { parsed: kept.parsed })
      return 'failed'
    }

    state.lastSeen = kept.sync.hash
    state.pending = null
    state.contentHash = prepared.keptContentHash
    await saveState()

    const counts = Object.entries(prepared.restoreSections).map(([name, records]) => `${name} ${records.length}`).join(', ')
    log(`took in sync file ${short(kept.sync.hash)} by ${writer} (base ${kept.parsed.base.file}), safety copy ${path.basename(result.safetyCopyPath)}, ${counts}, ${now() - started} ms`)

    return 'tookIn'
  }

  /**
   * What the startup does with what the folder holds, and the look again
   * while waiting for a base. Returns whether the data may load.
   * @param {KeptRead} kept
   * @param {{ freshLock?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function settle(kept, { freshLock = false } = {}) {
    if (kept.kind === 'none') {
      log('no sync file: the first tick writes one')
      return true
    }

    if (freshLock && kept.kind !== 'ok') {
      log(`a fresh lock, and the folder does not read cleanly (${kept.kind}): no take in`)
      return true
    }

    if (kept.sync.hash === state.lastSeen) {
      log(`sync file ${short(kept.sync.hash)} is last seen: nothing to take in`)
      if (kept.parsed?.ok && kept.parsed.header.installationId === installationId) {
        setStatus({ writtenAt: kept.sync.mtime })
      }
      return true
    }

    if (kept.sync.hash === state.pending) {
      log(`sync file ${short(kept.sync.hash)} is the pending one: now last seen`)
      state.lastSeen = kept.sync.hash
      state.pending = null
      await saveState()
      setStatus({ writtenAt: kept.sync.mtime })
      return true
    }

    switch (kept.kind) {
      case 'newer':
      case 'refused':
        pauseFor(kept)
        return true

      case 'baseMissing':
        return false

      case 'ok': {
        const outcome = await takeIn(kept)

        if (outcome === 'tookIn') {
          setStatus({ tookIn: { key: kept.sync.hash, machineName: kept.parsed.header.machineName, writtenAt: kept.sync.mtime } })
        }

        return true
      }
    }

    return true
  }

  /**
   * Pauses on what the folder holds when it cannot be taken in or written over
   * @param {Exclude<KeptRead, { kind: 'none' | 'ok' }>} kept
   */
  function pauseFor(kept) {
    switch (kept.kind) {
      case 'baseMissing':
        pause('baseMissing', kept.sync, { parsed: kept.parsed })
        return
      case 'refused':
        pause('refused', kept.sync, { parsed: kept.parsed, detail: kept.detail })
        return
      case 'newer':
        pause('newer', kept.sync, { formatVersion: kept.parsed.formatVersion })
    }
  }

  /** The sync file whose base is awaited at startup */
  let awaited = null

  /**
   * @param {Extract<KeptRead, { kind: 'baseMissing' }>} kept
   * @param {number | null} waitingSince
   */
  function arriving(kept, waitingSince) {
    awaited = kept
    setStatus({ arriving: { machineName: kept.parsed.header.machineName, writtenAt: kept.sync.mtime, waitingSince } })
  }

  // #endregion taking in

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

    const lock = await readLock(folder)
    const freshLock = lock.exists && lock.fresh

    if (freshLock) {
      log(`startup: a fresh lock by ${lock.machineName ?? 'an unknown machine'}`)
    }

    const kept = await readKept(folder, { retry: !freshLock })

    if (await settle(kept, { freshLock })) {
      markReady()
      return
    }

    log(`startup: asking whether to wait for the base of sync file ${short(kept.sync.hash)}`)
    arriving(kept, null)
  }

  /** While waiting for a base: look every ten seconds until it arrives or Tomas stops */
  async function waitForBase() {
    while (status.arriving?.waitingSince != null) {
      await sleep(LOOK_AGAIN_MS)

      const done = await exclusive(async () => {
        if (status.arriving?.waitingSince == null) { return true }

        const folder = await currentFolder()
        if (folder === null) {
          setStatus({ arriving: null })
          markReady()
          return true
        }

        const kept = await readKept(folder)

        if (kept.kind === 'baseMissing') {
          if (kept.sync.hash !== awaited?.sync.hash) {
            log(`a newer sync file ${short(kept.sync.hash)} arrived while waiting; its base is not here either`)
            arriving(kept, status.arriving.waitingSince)
          }
          return false
        }

        log(`waited ${Math.round((now() - status.arriving.waitingSince) / 1000)} s: ${kept.kind}`)
        await settle(kept)
        awaited = null
        setStatus({ arriving: null })
        markReady()
        return true
      })

      if (done) { return }
    }
  }

  /**
   * While paused the tick only reads: a base arriving after Continue, or a
   * newer sync file, updates the notice; the sync file being last seen again
   * resumes.
   * @param {string} folder
   */
  async function look(folder) {
    const sync = await readSync(folder)
    if (sync === null) { return }

    if (sync.hash === state.lastSeen) {
      log(`sync file ${short(sync.hash)} is last seen again: resuming`)
      resume()
      return
    }

    if (sync.hash === pausedOn && status.pause.reason !== 'baseMissing') { return }

    const kept = await readKept(folder, { retry: false })

    if (kept.kind === 'none') { return }

    if (kept.kind === 'ok') {
      pause('otherMachine', kept.sync, { parsed: kept.parsed })
    } else if (kept.sync.hash !== pausedOn || kept.kind !== status.pause.reason) {
      pauseFor(kept)
    }
  }

  async function tick() {
    if (!status.ready || relaunching) { return }

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

    switch (answer) {
      case 'restore': {
        if (status.pause?.reason !== 'otherMachine') { return }

        const kept = await readKept(folder)
        if (kept.kind === 'none') {
          log('restore: the sync file is gone; staying paused')
          return
        }

        if (kept.kind !== 'ok') {
          pauseFor(kept)
          return
        }

        relaunching = true
        const outcome = await takeIn(kept)

        if (outcome === 'failed') {
          relaunching = false
          return
        }

        if (outcome === 'same') {
          relaunching = false
          resume()
          return
        }

        log('relaunching after the restore')
        relaunch()
        return
      }

      case 'overwrite':
        if (status.pause === null || status.pause.reason === 'newer') { return }
        resume()
        overwriting = true
        changed = true
        await write(folder)
        return

      case 'wait':
        if (status.arriving === null || status.arriving.waitingSince !== null) { return }
        setStatus({ arriving: { ...status.arriving, waitingSince: now() } })
        waitForBase()
        return

      case 'continue':
      case 'stopWaiting': {
        if (status.arriving === null || awaited === null) { return }

        const kept = awaited
        awaited = null
        setStatus({ arriving: null })
        // Paused until the base arrives, when the notice asks Restore or Overwrite
        pauseFor(kept)
        markReady()
        break
      }

      case 'notNow':
      default:
    }
  }

  async function folderChosenStep() {
    const folder = await currentFolder()
    // Chosen again or anew, last seen starts unknown
    state = emptyState(folder)
    await saveState()

    setStatus({ pause: null, failure: null, writtenAt: null })
    pausedOn = null

    if (folder === null) { return }

    log(`folder chosen: ${folder}`)

    const kept = await readKept(folder, { retry: false })

    const ours = kept.kind !== 'none' && kept.parsed?.ok && kept.parsed.header.installationId === installationId

    if (kept.kind === 'none' || ours) {
      overwriting = true
      changed = true
      await write(folder)
      return
    }

    if (kept.kind === 'ok') {
      pause('otherMachine', kept.sync, { parsed: kept.parsed })
    } else {
      pauseFor(kept)
    }
  }

  async function stopStep() {
    log('stop keeping: setting cleared, files left in place')
    await datastores.settings.updateAsync({ _id: 'backupFolder' }, { _id: 'backupFolder', value: '' }, { upsert: true })
    state = emptyState(null)
    await saveState()
    pausedOn = null
    overwriting = false
    setStatus({ folder: null, pause: null, failure: null, writtenAt: null, arriving: null })
  }

  async function quitStep() {
    if (!status.ready || relaunching || status.pause !== null || !changed) {
      log(`quit: no write (${!status.ready ? 'not ready' : relaunching ? 'relaunching' : status.pause !== null ? 'paused' : 'nothing changed'})`)
      return
    }

    const folder = await currentFolder()
    if (folder === null) { return }

    log('quit: writing')
    await write(folder)
  }

  // #endregion the steps

  return {
    /** The startup check; resolves once it has decided, which may be before ready */
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
    quit: (limit = QUIT_LIMIT_MS) => Promise.race([
      exclusive(quitStep).catch(() => {}),
      sleep(limit).then(() => log('quit: the write did not finish in time')),
    ]),

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
