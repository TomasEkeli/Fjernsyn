import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { isRendererWritableYtDlpSetting } from '../ytdlp/settings'

/**
 * A restore, in main: the safety copy written, each section in the request
 * put in place of what the datastore holds, then a relaunch, so that every
 * window, store and scheduler starts on the new data (ADR-0022).
 *
 * The renderer has read and checked the backup (helpers/backup.js) and built
 * the safety copy; main writes them. It takes its datastores, data folder and
 * relaunch as arguments, so that a test runs it on temporary files.
 */

/** The folder in the data folder that holds the safety copies */
export const BACKUPS_FOLDER = 'backups'

/** How many safety copies are kept: the newest, once a new one is written */
export const SAFETY_COPIES_KEPT = 3

const SAFETY_COPY_PATTERN = /^before-restore-\d{4}-\d{2}-\d{2}-\d{6}\.json$/

/**
 * The datastore each section of a backup replaces, in the order they are written
 * @type {ReadonlyArray<[section: string, datastore: string]>}
 */
const SECTION_DATASTORES = Object.freeze([
  ['profiles', 'profiles'],
  ['history', 'history'],
  ['playlists', 'playlists'],
  ['later', 'later'],
  ['searchHistory', 'searchHistory'],
  ['settings', 'settings'],
  ['channels', 'channels'],
  ['aiVerdicts', 'aiVerdicts'],
])

/**
 * Settings a restore never writes, whatever the request says. The paths only
 * main's pickers may set, as the settings channel refuses them too, and what
 * belongs to this data folder alone.
 * @param {string} id
 * @param {unknown} value
 */
function isRestorableSetting(id, value) {
  return id !== 'screenshotFolderPath' &&
    id !== 'backupFolder' &&
    id !== 'installationId' &&
    id !== 'bounds' &&
    isRendererWritableYtDlpSetting(id, value)
}

/**
 * @typedef {import('@seald-io/nedb').default} Datastore
 * @typedef {Record<'settings' | 'profiles' | 'playlists' | 'history' | 'searchHistory' | 'channels' | 'aiVerdicts' | 'later', Datastore>} Datastores
 */

/**
 * @typedef {object} RestoreRequest
 * @property {string} safetyCopy the app's data as it is now, in the backup format
 * @property {Record<string, Record<string, any>[]>} sections the sections to replace, each with the records to write
 */

/**
 * @typedef {{ ok: true, safetyCopyPath: string } | { ok: false, error: string, safetyCopyPath: string | null }} RestoreResult
 */

/**
 * The safety copy's file name, in local time, so that it sorts by when
 * @param {Date} date
 */
export function safetyCopyName(date) {
  const pad = (number, length = 2) => String(number).padStart(length, '0')

  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`

  return `before-restore-${day}-${time}.json`
}

/**
 * @param {string} dataFolder
 */
export function backupsFolder(dataFolder) {
  return path.join(dataFolder, BACKUPS_FOLDER)
}

/**
 * Writes the safety copy, replaces each section in the request, compacts what
 * it wrote and relaunches. A step that fails stops it there, without a
 * relaunch: some sections may be replaced already, and the safety copy is
 * the way back.
 *
 * @param {object} deps
 * @param {Datastores} deps.datastores
 * @param {string} deps.dataFolder
 * @param {() => void} deps.relaunch
 * @param {() => Date} [deps.now]
 * @param {Pick<typeof fs, 'mkdir' | 'writeFile' | 'readdir' | 'rm'>} [deps.fileSystem]
 * @param {unknown} request
 * @returns {Promise<RestoreResult>}
 */
export async function restoreBackup({ datastores, dataFolder, relaunch, now = () => new Date(), fileSystem = fs }, request) {
  const problem = requestProblem(request)
  if (problem !== null) {
    return { ok: false, error: problem, safetyCopyPath: null }
  }

  const folder = backupsFolder(dataFolder)
  const safetyCopyPath = path.join(folder, safetyCopyName(now()))

  try {
    await fileSystem.mkdir(folder, { recursive: true })
    await fileSystem.writeFile(safetyCopyPath, request.safetyCopy, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    return { ok: false, error: `Could not write the safety copy: ${errorText(error)}`, safetyCopyPath: null }
  }

  /** @type {Datastore[]} */
  const written = []

  try {
    for (const [section, name] of SECTION_DATASTORES) {
      if (!Object.hasOwn(request.sections, section)) { continue }

      const datastore = datastores[name]
      const records = request.sections[section]

      if (section === 'settings') {
        for (const { _id, value } of records) {
          if (isRestorableSetting(_id, value)) {
            await datastore.updateAsync({ _id }, { _id, value }, { upsert: true })
          }
        }
      } else {
        // Queued together, so that no write from another window lands between
        // the two: the datastore runs its commands in order
        await Promise.all([
          datastore.removeAsync({}, { multi: true }),
          records.length > 0 ? datastore.insertAsync(records) : null,
        ])
      }

      written.push(datastore)
    }

    for (const datastore of written) {
      await datastore.compactDatafileAsync()
    }
  } catch (error) {
    return { ok: false, error: errorText(error), safetyCopyPath }
  }

  // Only now, so that failed attempts never push out the copy from before
  // the first of them
  await removeOldSafetyCopies(folder, fileSystem)

  try {
    relaunch()
  } catch (error) {
    return { ok: false, error: `Could not restart: ${errorText(error)}`, safetyCopyPath }
  }

  return { ok: true, safetyCopyPath }
}

/**
 * What is wrong with a request, before anything is written; null when nothing
 * @param {unknown} request
 * @returns {string | null}
 */
function requestProblem(request) {
  if (request === null || typeof request !== 'object') {
    return 'The restore request is empty'
  }

  const { safetyCopy, sections } = /** @type {Record<string, unknown>} */ (request)

  if (typeof safetyCopy !== 'string' || safetyCopy === '') {
    return 'The restore request has no safety copy'
  }

  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) {
    return 'The restore request has no sections'
  }

  const known = new Set(SECTION_DATASTORES.map(([section]) => section))

  for (const [section, records] of Object.entries(sections)) {
    if (!known.has(section)) {
      return `The restore request has an unknown section: ${section}`
    }

    if (!Array.isArray(records) || !records.every(record => record !== null && typeof record === 'object' && !Array.isArray(record))) {
      return `The restore request's ${section} section is not a list of records`
    }

    if (section === 'settings' && !records.every(record => typeof record._id === 'string')) {
      return 'The restore request has a setting without a name'
    }

    if (!records.every(isStorable)) {
      return `The restore request's ${section} section has a field name the datastore cannot store`
    }
  }

  return null
}

/**
 * Whether the datastore can store a record: it refuses a field name that
 * begins with $ or has a dot in it, at any level. Checked before anything is
 * written, as a section whose insert fails is left empty.
 * @param {unknown} value
 * @returns {boolean}
 */
function isStorable(value) {
  if (Array.isArray(value)) {
    return value.every(isStorable)
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(([name, inner]) => !name.startsWith('$') && !name.includes('.') && isStorable(inner))
  }

  return true
}

/**
 * Keeps the newest safety copies, by name, which sorts by time. Failing to
 * remove an old one costs only space, so it is logged and the restore goes on.
 * @param {string} folder
 * @param {Pick<typeof fs, 'readdir' | 'rm'>} fileSystem
 */
async function removeOldSafetyCopies(folder, fileSystem) {
  try {
    const copies = (await fileSystem.readdir(folder))
      .filter(name => SAFETY_COPY_PATTERN.test(name))
      .sort()

    for (const name of copies.slice(0, Math.max(0, copies.length - SAFETY_COPIES_KEPT))) {
      await fileSystem.rm(path.join(folder, name), { force: true })
    }
  } catch (error) {
    console.error('Could not remove the old safety copies', error)
  }
}

/**
 * The installation id, made once per data folder and kept for good: a backup's
 * header says which installation wrote it. A copy of a whole data folder
 * copies it too, which is accepted.
 *
 * @param {Datastore} settings the settings datastore
 * @param {() => string} [makeId]
 * @returns {Promise<string>}
 */
export async function ensureInstallationId(settings, makeId = randomUUID) {
  const existing = await settings.findOneAsync({ _id: 'installationId' })

  if (typeof existing?.value === 'string' && existing.value !== '') {
    return existing.value
  }

  const value = makeId()
  await settings.updateAsync({ _id: 'installationId' }, { _id: 'installationId', value }, { upsert: true })

  return value
}

/**
 * @param {unknown} error
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
