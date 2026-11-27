import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'

import { sha256 } from './keeperWorker'
import { applyChanges, baseFileName, chooseArchive, isBaseFileName, readArchiveHeader, readSyncFile, SYNC_FILE_NAME } from '../../renderer/helpers/keptBackup'
import { mergeSections } from '../../renderer/helpers/keptMerge'

/**
 * Meeting a folder for the first time: a machine enrolled, a machine updated
 * and a machine that lost its keeper state all come this way. It merges, and
 * it never restores over this machine's own data, so the machine that lagged
 * behind the other by a day loses nothing of what it did while it lagged.
 * The design is `.scratch/evented-sync/spec.md`, "Enrolling a machine".
 *
 * The merge is `keptMerge.js`'s, a union with no ancestor, which the spec
 * keeps for this path alone. An empty data folder meeting an archive gets the
 * archive, so enrolment needs no case of its own.
 */

const gunzip = promisify(gunzipCallback)

/** This machine's intents from before a folder was chosen, in the data folder */
export const PENDING_LOG_NAME = 'pending-events.jsonl'

export const PENDING_CAP = 10_000
export const PENDING_MS = 30 * 24 * 60 * 60_000

/**
 * The pending log as it is kept: the intents recorded before this machine was
 * pointed at a folder, so that a week of use beforehand enrols with its
 * intents intact.
 *
 * It is capped so that a machine never enrolled does not grow one for ever.
 * Past the cap the oldest go, and the keys they named enrol as a union, which
 * is what enrolment would have been without any of this.
 *
 * @param {{ at: number }[]} events in the order they were made
 * @param {number} at
 */
export function capPending(events, at) {
  const young = events.filter(event => at - event.at <= PENDING_MS)

  return young.slice(Math.max(0, young.length - PENDING_CAP))
}

/**
 * @typedef {import('../../renderer/helpers/keptBackup').Cut} Cut
 * @typedef {import('../../renderer/helpers/keptBackup').Sections} Sections
 * @typedef {import('../../renderer/helpers/keptBackup').Changes} Changes
 * @typedef {import('../../renderer/helpers/intentLog').Ranges} Ranges
 */

/**
 * The applied ranges an archive's cut seeds: every sequence number a machine
 * wrote up to its cut is folded into the archive already, so taking the
 * archive in is taking those events in.
 *
 * Without this a machine joining a folder whose old segments have been
 * trimmed holds back every one of another machine's events for ever, since a
 * machine's events are applied in sequence order and sequence number 1 is in
 * no segment the folder still has.
 *
 * @param {Cut} cut
 * @param {Record<string, Ranges>} [applied] the ranges this machine already has, which the seeding only ever adds to
 * @returns {Record<string, Ranges>}
 */
export function appliedFromCut(cut, applied = {}) {
  const seeded = structuredClone(applied)

  for (const [by, seq] of Object.entries(cut)) {
    if (!Number.isInteger(seq) || seq <= 0) { continue }

    const ranges = [[1, seq], ...(seeded[by] ?? [])].sort((a, b) => a[0] - b[0])
    const merged = [ranges[0]]

    for (const [from, to] of ranges.slice(1)) {
      const last = merged[merged.length - 1]

      if (from <= last[1] + 1) {
        last[1] = Math.max(last[1], to)
      } else {
        merged.push([from, to])
      }
    }

    seeded[by] = merged
  }

  return seeded
}

/**
 * The folder's archives, unpacked, each checked against the hash in its name
 * @param {string} folder
 * @param {{ readdir: Function, readFile: Function }} fileSystem
 * @param {(message: string) => void} log
 * @returns {Promise<{ hash: string, cut: Cut, text: string }[]>}
 */
async function readArchives(folder, fileSystem, log) {
  let names
  try {
    names = await fileSystem.readdir(folder)
  } catch {
    return []
  }

  const archives = []

  for (const name of names.sort()) {
    if (!isBaseFileName(name)) { continue }

    let text
    try {
      text = (await gunzip(await fileSystem.readFile(path.join(folder, name)))).toString('utf8')
    } catch (error) {
      log(`archive ${name} could not be read: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const hash = sha256(text)

    if (baseFileName(hash) !== name) {
      log(`archive ${name} does not match its name: left alone`)
      continue
    }

    const header = readArchiveHeader(text)
    if (!header.ok) {
      log(`archive ${name} does not read as one (${header.reason}): left alone`)
      continue
    }

    archives.push({ hash, cut: header.cut, text })
  }

  return archives
}

/**
 * The changes `fjernsyn-sync.json` has since the base it names, where the
 * folder is still in the layout the version before this one wrote. The
 * machine still on that version goes on writing the file, and the one that
 * has been updated no longer reads it after this, so everything the old
 * machine did since its last rebase comes in here or not at all.
 *
 * Only ever against the archive this meeting took. A folder already in the
 * new layout keeps the file it was left with, and that one is stale: it is
 * against a base no archive is, and a union with it would bring back records
 * the new layout has since seen removed.
 *
 * @param {string} folder
 * @param {{ readFile: Function }} fileSystem
 * @param {{ hash: string }} chosen
 * @param {(message: string) => void} log
 * @returns {Promise<Changes | null>}
 */
async function changesSinceTheBase(folder, fileSystem, chosen, log) {
  let text
  try {
    text = await fileSystem.readFile(path.join(folder, SYNC_FILE_NAME), 'utf8')
  } catch {
    return null
  }

  const sync = readSyncFile(text)

  if (!sync.ok) {
    log(`${SYNC_FILE_NAME} does not read as one (${sync.reason}): the archive alone is taken in`)
    return null
  }

  if (sync.base.sha256 !== chosen.hash) {
    log(`${SYNC_FILE_NAME} is against another base: left alone, as the new layout has what it held`)
    return null
  }

  log(`${SYNC_FILE_NAME} is against this archive: the folder is in the old layout, and its changes come in with it`)
  return sync.changes
}

/**
 * The archive's sections, with the old layout's changes applied where there
 * are any, and without the settings that belong to a machine: another
 * machine's proxy, its external player and its own backup folder are never
 * written here, in either direction
 * @param {string} text
 * @param {ReadonlySet<string>} machineBound
 * @param {Changes | null} changes
 * @returns {Sections | null} null when the text has no sections
 */
function theirSections(text, machineBound, changes) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return null
  }

  const archived = document?.sections
  if (archived === null || typeof archived !== 'object' || Array.isArray(archived)) { return null }

  const sections = changes === null ? archived : applyChanges(archived, changes)

  if (!Array.isArray(sections.settings)) { return sections }

  return { ...sections, settings: sections.settings.filter(record => !machineBound.has(record?._id)) }
}

/**
 * What this machine's data becomes when it meets a folder: the archive the
 * folder offers merged in as a union, and the applied ranges its cut seeds.
 *
 * @param {object} meeting
 * @param {string} meeting.folder
 * @param {{ readdir: Function, readFile: Function }} meeting.fileSystem
 * @param {Sections} meeting.sections this machine's data as it is now
 * @param {ReadonlySet<string>} meeting.machineBound the settings that never travel
 * @param {Record<string, Ranges>} [meeting.applied] the ranges this machine already has
 * @param {(message: string) => void} [meeting.log]
 * @returns {Promise<{ archive: string | null, toApply: Changes, applied: Record<string, Ranges> }>}
 */
export async function firstMeeting({ folder, fileSystem, sections, machineBound, applied = {}, log = () => {} }) {
  const nothing = { archive: null, toApply: {}, applied }

  const archives = await readArchives(folder, fileSystem, log)
  if (archives.length === 0) { return nothing }

  const hash = chooseArchive(archives)
  const chosen = archives.find(archive => archive.hash === hash)

  const changes = await changesSinceTheBase(folder, fileSystem, chosen, log)

  const theirs = theirSections(chosen.text, machineBound, changes)
  if (theirs === null) { return nothing }

  const { toApply, conflicts } = mergeSections({ ancestor: null, theirs, ours: sections })
  const moved = Object.values(toApply).reduce((count, { put, remove }) => count + put.length + remove.length, 0)

  log(`met the folder: archive ${hash.slice(0, 12)}, ${moved} record${moved === 1 ? '' : 's'} merged in, ${conflicts} both sides had changed`)

  return { archive: hash, toApply, applied: appliedFromCut(chosen.cut, applied) }
}

/**
 * The installation id this machine writes its own files under. A data folder
 * copied to a second machine, which is a plausible way to set one up, puts
 * two machines on one id, one segment name and one counter, and they give one
 * sequence number to two different events in a folder that has no lock. It is
 * the one way this design can corrupt the folder, so a copy is caught twice
 * over: by the host name having changed since this id last ran, and by this
 * machine's own segment showing a sequence number twice, which is what two
 * machines counting from the same saved state write.
 *
 * @param {object} identity
 * @param {string} identity.installationId the id this machine has been using
 * @param {string | null} identity.hostName
 * @param {string | null} identity.lastHostName the host name this id last ran under
 * @param {import('../../renderer/helpers/intentLog').IntentEvent[]} [identity.ownSegment] this machine's own segment, as read
 * @param {() => string} [identity.mint]
 * @returns {Promise<string>}
 */
export async function ensureOwnIdentity({ installationId, hostName, lastHostName, ownSegment = [], mint = randomUUID }) {
  const movedHost = hostName !== null && lastHostName !== null && hostName !== lastHostName

  const seen = new Set()
  const written = ownSegment.some((event) => {
    if (seen.has(event.seq)) { return true }
    seen.add(event.seq)
    return false
  })

  return movedHost || written ? mint() : installationId
}
