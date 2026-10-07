import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { parentPort, workerData } from 'node:worker_threads'

import { readBackup, writeBackup } from '../../renderer/helpers/backup'
import {
  applyChanges,
  baseFileName,
  computeChanges,
  contentText,
  readSyncFile,
  rebaseNeeded,
  writeSyncFile,
} from '../../renderer/helpers/keptBackup'

/**
 * The kept backup's heavy work, off main's thread: building the content and
 * the changes against the base, writing a new base and gzipping it, and
 * reading what another machine wrote for a take in. On Tomas's data a
 * stringify is a third of a second and a gzip most of one, which on main's
 * thread would freeze every window (spec, "Where the work runs").
 *
 * Each job is a plain function of its input, so the keeper's tests run the
 * same code inline (`runKeeperJob`) where the app runs it in a worker thread.
 * The worker keeps the last base it was given, parsed, so that a tick does
 * not parse 30 MB again when the base has not changed.
 */

/**
 * @typedef {{ appVersion: string, installationId: string, machineName: string | null }} KeeperHeader
 * @typedef {Record<string, Record<string, any>[]>} Sections
 */

/**
 * @typedef {object} BuildJob
 * @property {'build'} type
 * @property {Sections} sections this machine's content, every section
 * @property {KeeperHeader} header
 * @property {{ file: string, sha256: string, text: string } | null} base the base the sync file builds on; null to write a new one
 * @property {string | null} lastContentHash the content last written or taken in, when the sync file in the folder is that one
 * @property {boolean} [forceRebase]
 */

/**
 * @typedef {{ contentHash: string, unchanged: true } | {
 *   contentHash: string,
 *   unchanged: false,
 *   syncText: string,
 *   syncHash: string,
 *   newBase: { file: string, sha256: string, text: string, gz: Uint8Array } | null,
 * }} BuildResult
 */

/**
 * @typedef {object} TakeInJob
 * @property {'prepareTakeIn'} type
 * @property {string} syncText the sync file, already read cleanly
 * @property {string} baseText its base, unpacked and its hash checked
 * @property {Sections} sections this machine's content, for the comparison and the safety copy
 * @property {KeeperHeader} header this machine's, for the safety copy
 * @property {string[]} machineBound the settings a take in never writes
 */

/**
 * @typedef {{ ok: false, reason: string } | {
 *   ok: true,
 *   keptContentHash: string,
 *   localContentHash: string,
 *   restoreSections: Sections,
 *   safetyCopy: string,
 * }} TakeInResult
 */

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** @type {{ sha256: string, sections: Sections } | null} */
let parsedBase = null

/**
 * The base's sections, parsed once per base
 * @param {{ sha256: string, text: string }} base
 * @returns {Sections | null} null when the text is no backup
 */
function baseSections(base) {
  if (parsedBase?.sha256 === base.sha256) {
    return parsedBase.sections
  }

  let document
  try {
    document = JSON.parse(base.text)
  } catch {
    return null
  }

  if (document === null || typeof document !== 'object' || document.sections === null || typeof document.sections !== 'object' || Array.isArray(document.sections)) {
    return null
  }

  parsedBase = { sha256: base.sha256, sections: document.sections }
  return document.sections
}

/**
 * @param {BuildJob} job
 * @returns {BuildResult}
 */
function build({ sections, header, base, lastContentHash, forceRebase = false }) {
  const contentHash = sha256(contentText(sections))

  if (lastContentHash !== null && contentHash === lastContentHash) {
    return { contentHash, unchanged: true }
  }

  const onBase = base !== null && !forceRebase ? baseSections(base) : null

  if (onBase !== null) {
    const syncText = writeSyncFile({ ...header, base: { file: base.file, sha256: base.sha256 }, changes: computeChanges(onBase, sections) })

    if (!rebaseNeeded(syncText)) {
      return { contentHash, unchanged: false, syncText, syncHash: sha256(syncText), newBase: null }
    }
  }

  // A rebase: a new base of everything, and a sync file with no changes on it
  const text = writeBackup({ ...header, sections })
  const hash = sha256(text)
  const file = baseFileName(hash)
  const syncText = writeSyncFile({ ...header, base: { file, sha256: hash }, changes: {} })

  parsedBase = { sha256: hash, sections }

  return {
    contentHash,
    unchanged: false,
    syncText,
    syncHash: sha256(syncText),
    newBase: { file, sha256: hash, text, gz: gzipSync(text) },
  }
}

/**
 * What a take in writes: the base with the changes applied, through the
 * backup's write and read as a restored backup would go, and the safety copy
 * of this machine's data
 * @param {TakeInJob} job
 * @returns {TakeInResult}
 */
function prepareTakeIn({ syncText, baseText, sections, header, machineBound }) {
  const sync = readSyncFile(syncText)
  if (!sync.ok) {
    return { ok: false, reason: sync.reason }
  }

  const base = baseSections({ sha256: sync.base.sha256, text: baseText })
  if (base === null) {
    return { ok: false, reason: 'baseUnreadable' }
  }

  const kept = applyChanges(base, sync.changes)

  const contents = readBackup(
    writeBackup({ appVersion: sync.header.appVersion ?? '', installationId: sync.header.installationId ?? '', machineName: sync.header.machineName, sections: kept }),
    { machineBoundSettings: machineBound, keepUnknownSettings: true }
  )

  if (!contents.ok) {
    return { ok: false, reason: contents.reason }
  }

  return {
    ok: true,
    keptContentHash: sha256(contentText(kept)),
    localContentHash: sha256(contentText(sections)),
    restoreSections: contents.sections,
    safetyCopy: writeBackup({ ...header, sections }),
  }
}

/**
 * @param {BuildJob | TakeInJob} job
 * @returns {BuildResult | TakeInResult}
 */
export function runKeeperJob(job) {
  switch (job.type) {
    case 'build':
      return build(job)
    case 'prepareTakeIn':
      return prepareTakeIn(job)
    default:
      throw new Error(`Unknown keeper job: ${job.type}`)
  }
}

// Only when started as the keeper's worker: a test that imports this file
// may itself run in a worker thread, whose port is not ours
if (parentPort !== null && workerData?.fjernsynKeeper === true) {
  parentPort.on('message', ({ id, job }) => {
    try {
      // Copied, not transferred: a small gzip's buffer may be a slice of
      // Node's shared pool, which a transfer would take from under the rest
      parentPort.postMessage({ id, result: runKeeperJob(job) })
    } catch (error) {
      parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
