import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { parentPort, workerData } from 'node:worker_threads'

import { BACKUP_SECTIONS, readBackup, writeBackup } from '../../renderer/helpers/backup'
import { mergeSections } from '../../renderer/helpers/keptMerge'
import {
  applyChanges,
  baseFileName,
  contentText,
  readSyncFile,
  writeArchive,
} from '../../renderer/helpers/keptBackup'
import { stateChangesSince } from '../../renderer/helpers/stateFile'

/**
 * The kept backup's heavy work, off main's thread: building this machine's
 * state records against the archive, writing a new archive and gzipping it,
 * and merging what another machine wrote with this one's data. On a full data
 * folder a stringify is a third of a second and a gzip most of one, which on
 * main's thread would freeze every window (spec, "Where the work runs").
 *
 * Each job is a plain function of its input, so the keeper's tests run the
 * same code inline (`runKeeperJob`) where the app runs it in a worker thread.
 * The worker keeps the last archive it was given, parsed, so that a tick does
 * not parse 30 MB again when the archive has not changed.
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
 * @property {import('../../renderer/helpers/keptBackup').Cut} [cut] what a new archive has folded in
 * @property {{ sha256: string, text: string } | null} archive the archive the state file is a delta against, null to write a new one
 * @property {number} at the time this machine last changed the state fields it names
 * @property {string | null} lastContentHash the content last written
 * @property {boolean} [wantArchive] the segment and the state file have grown past the threshold
 */

/**
 * @typedef {{ contentHash: string, unchanged: true } | {
 *   contentHash: string,
 *   unchanged: false,
 *   records: Record<string, import('../../renderer/helpers/stateFile').StateRecord>,
 *   newArchive: { file: string, sha256: string, text: string, gz: Uint8Array } | null,
 * }} BuildResult
 */

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The last two archives parsed, by hash. An archive is a backup with a cut in
 * its header, so a base of the old layout parses as readily.
 * @type {Map<string, Sections>}
 */
const parsedBases = new Map()

/**
 * @param {string} hash
 * @param {Sections} sections
 */
function rememberBase(hash, sections) {
  parsedBases.delete(hash)
  parsedBases.set(hash, sections)
  while (parsedBases.size > 2) {
    parsedBases.delete(parsedBases.keys().next().value)
  }
}

/**
 * The base's sections, parsed once per base
 * @param {{ sha256: string, text: string }} base
 * @returns {Sections | null} null when the text is no backup
 */
function baseSections(base) {
  if (parsedBases.has(base.sha256)) {
    return parsedBases.get(base.sha256)
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

  rememberBase(base.sha256, document.sections)
  return document.sections
}

/**
 * What this machine has to say about every section's state fields, by the
 * key an event names the record by
 * @param {Sections} sections
 * @param {Sections} archived
 * @param {number} at
 */
function stateRecords(sections, archived, at) {
  const records = {}

  for (const section of BACKUP_SECTIONS) {
    Object.assign(records, stateChangesSince(section, sections[section] ?? [], archived[section] ?? [], at))
  }

  return records
}

/**
 * @param {BuildJob} job
 * @returns {BuildResult}
 */
function build({ sections, header, cut = {}, archive, at, lastContentHash, wantArchive = false }) {
  const contentHash = sha256(contentText(sections))

  // An archive is wanted because the segment and the state file have grown,
  // which an appended intent does without changing a record here
  if (!wantArchive && lastContentHash !== null && contentHash === lastContentHash) {
    return { contentHash, unchanged: true }
  }

  const folded = archive !== null && !wantArchive ? baseSections(archive) : null

  if (folded !== null) {
    return { contentHash, unchanged: false, records: stateRecords(sections, folded, at), newArchive: null }
  }

  const text = writeArchive({ ...header, cut, sections })
  const hash = sha256(text)

  rememberBase(hash, sections)

  return {
    contentHash,
    unchanged: false,
    // A new archive has every state field there is, so nothing is a delta
    // against it yet
    records: stateRecords(sections, sections, at),
    newArchive: { file: baseFileName(hash), sha256: hash, text, gz: gzipSync(text) },
  }
}

/**
 * @typedef {object} MergeJob
 * @property {'merge'} type
 * @property {{ syncText: string, baseText: string }} theirs the folder's sync file and its base, read cleanly
 * @property {{ syncText: string, baseText: string } | null} ancestor the shared state's, or null when it is not known
 * @property {Sections} sections this machine's content
 * @property {KeeperHeader} header this machine's, for the safety copy
 * @property {string[]} machineBound the settings a take in never writes
 * @property {boolean} wantSafetyCopy
 */

/**
 * @typedef {{ ok: false, reason: string } | {
 *   ok: true,
 *   theirContentHash: string,
 *   mergedContentHash: string,
 *   toApply: import('../../renderer/helpers/keptBackup').Changes,
 *   conflicts: number,
 *   safetyCopy: string | null,
 * }} MergeResult
 */

/**
 * A sync file and its base, as the state they make
 * @param {{ syncText: string, baseText: string }} pair
 * @returns {{ ok: true, sync: any, sections: Sections } | { ok: false, reason: string }}
 */
function stateOf({ syncText, baseText }) {
  const sync = readSyncFile(syncText)
  if (!sync.ok) {
    return { ok: false, reason: sync.reason }
  }

  const base = baseSections({ sha256: sync.base.sha256, text: baseText })
  if (base === null) {
    return { ok: false, reason: 'baseUnreadable' }
  }

  return { ok: true, sync, sections: applyChanges(base, sync.changes) }
}

/**
 * What this machine's data becomes with the folder's merged in: theirs read
 * as a restored backup would be, then merged with ours against the shared
 * state, when it is known
 * @param {MergeJob} job
 * @returns {MergeResult}
 */
function merge({ theirs, ancestor, sections, header, machineBound, wantSafetyCopy }) {
  const their = stateOf(theirs)
  if (!their.ok) {
    return their
  }

  const contents = readBackup(
    writeBackup({ appVersion: their.sync.header.appVersion ?? '', installationId: their.sync.header.installationId ?? '', machineName: their.sync.header.machineName, sections: their.sections }),
    { machineBoundSettings: machineBound, keepUnknownSettings: true }
  )

  if (!contents.ok) {
    return { ok: false, reason: contents.reason }
  }

  const shared = ancestor === null ? null : stateOf(ancestor)

  const { merged, toApply, conflicts } = mergeSections({
    ancestor: shared?.ok ? shared.sections : null,
    theirs: contents.sections,
    ours: sections,
  })

  return {
    ok: true,
    theirContentHash: sha256(contentText(their.sections)),
    mergedContentHash: sha256(contentText(merged)),
    toApply,
    conflicts,
    safetyCopy: wantSafetyCopy && Object.keys(toApply).length > 0 ? writeBackup({ ...header, sections }) : null,
  }
}

/**
 * @param {BuildJob | MergeJob} job
 * @returns {BuildResult | MergeResult}
 */
export function runKeeperJob(job) {
  switch (job.type) {
    case 'build':
      return build(job)
    case 'merge':
      return merge(job)
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
