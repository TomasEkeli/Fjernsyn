/**
 * The intent log: a machine's own events, one per line, appended and never
 * rewritten. This module writes a line, reads a segment back, puts events in
 * the one order every machine agrees on, and keeps the sequence numbers a
 * machine has taken from another as ranges.
 *
 * Pure, as the backup helpers are, and importable from main: nothing here
 * imports Electron, and the one import is a string comparison. Nothing here
 * opens a file either. Main reads a segment's text and hands it over.
 *
 * A segment grows while it is being read, and a sync tool may deliver it
 * mid-append, so the reader takes whole lines alone: a last line with no
 * newline is the one line that has not arrived yet, and the next read takes
 * it whole.
 */

import { compareStrings } from './backup'

/**
 * One intent, written down
 * @typedef {object} IntentEvent
 * @property {number} seq this machine's own counter, never reused
 * @property {number} at the wall clock time of the intent itself
 * @property {string} by the installation id of the machine that recorded it
 * @property {string} type `<section>.<what happened>`
 * @property {string} key what the intent is about
 * @property {Record<string, any>} data the intent fields the event sets, and nothing else
 */

/** Sorted, inclusive and never touching @typedef {[number, number][]} Ranges */

const SEGMENT_PREFIX = 'events-'
const SEGMENT_SUFFIX = '.jsonl'
const SEGMENT_INDEX = /^(0|[1-9][0-9]*)$/

/**
 * A segment's file name in the backup folder
 * @param {string} installationId the machine that owns it
 * @param {number} index counting this machine's segments, a new one at each archive
 * @returns {string} `events-<installation id>-<index>.jsonl`
 */
export function segmentName(installationId, index) {
  // A name the reader would refuse must never be written
  if (typeof installationId !== 'string' || installationId === '' || !Number.isInteger(index) || index < 0) {
    throw new TypeError('A segment is named by an installation id and a whole index')
  }

  return `${SEGMENT_PREFIX}${installationId}-${index}${SEGMENT_SUFFIX}`
}

/**
 * What a segment's file name says: the machine that owns it and the index,
 * or null when the name is not a segment's
 * @param {string} name
 * @returns {{ installationId: string, index: number } | null}
 */
export function parseSegmentName(name) {
  if (typeof name !== 'string' || !name.startsWith(SEGMENT_PREFIX) || !name.endsWith(SEGMENT_SUFFIX)) {
    return null
  }

  const stem = name.slice(SEGMENT_PREFIX.length, -SEGMENT_SUFFIX.length)
  const split = stem.lastIndexOf('-')
  if (split < 1) { return null }

  const installationId = stem.slice(0, split)
  const index = stem.slice(split + 1)
  if (!SEGMENT_INDEX.test(index)) { return null }

  return { installationId, index: Number(index) }
}

/**
 * One event as a line of the segment: the keys in a fixed order, no newline
 * inside it, and a newline to end it
 * @param {IntentEvent} event
 * @returns {string}
 */
export function writeEventLine({ seq, at, by, type, key, data }) {
  return JSON.stringify({ seq, at, by, type, key, data }) + '\n'
}

/**
 * A segment's text as the whole events in it. A line that is not an event is
 * dropped, and so is a last line with no newline, which `partial` says.
 *
 * @param {string} text
 * @returns {{ events: IntentEvent[], partial: boolean }}
 */
export function readSegment(text) {
  const lines = text.split('\n')

  // The split's last part is what follows the last newline: empty when the
  // text ended in one, and a half-written line when it did not
  const partial = lines.pop() !== ''

  const events = []

  for (const line of lines) {
    if (line === '') { continue }

    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (!isEvent(parsed)) { continue }

    events.push(parsed.data === undefined ? { ...parsed, data: {} } : parsed)
  }

  return { events, partial }
}

/**
 * The order every machine puts events in: when the intent happened, ties by
 * the machine that recorded it, then by its own counter
 * @param {IntentEvent} a
 * @param {IntentEvent} b
 * @returns {number}
 */
export function compareEvents(a, b) {
  if (a.at !== b.at) { return a.at < b.at ? -1 : 1 }

  const by = compareStrings(a.by, b.by)
  if (by !== 0) { return by }

  if (a.seq === b.seq) { return 0 }
  return a.seq < b.seq ? -1 : 1
}

/**
 * The ranges with one more sequence number in them, joined onto a neighbour
 * and closing a gap where it fills one. The ranges given are not changed.
 *
 * @param {Ranges} ranges
 * @param {number} seq
 * @returns {Ranges}
 */
export function addToRanges(ranges, seq) {
  const all = [...ranges.map(([from, to]) => [from, to]), [seq, seq]].sort((a, b) => a[0] - b[0])

  const joined = []

  for (const [from, to] of all) {
    const last = joined[joined.length - 1]

    if (last !== undefined && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to)
    } else {
      joined.push([from, to])
    }
  }

  return joined
}

/**
 * Whether a sequence number has already been taken
 * @param {Ranges} ranges
 * @param {number} seq
 */
export function rangesHold(ranges, seq) {
  return ranges.some(([from, to]) => seq >= from && seq <= to)
}

// #region helpers

/**
 * The five fields an event cannot be read without. `data` may be absent, and
 * is read as empty. A `data` that is there and is not an object makes the
 * line no event, because the fold reads its fields without checking them: a
 * line skipped here costs one intent, and the same line reaching the fold
 * costs the whole tick.
 * @param {unknown} value
 * @returns {value is IntentEvent}
 */
function isEvent(value) {
  return isPlainObject(value) &&
    Number.isInteger(value.seq) && typeof value.at === 'number' && Number.isFinite(value.at) &&
    typeof value.by === 'string' && value.by !== '' &&
    typeof value.type === 'string' && value.type !== '' &&
    typeof value.key === 'string' && value.key !== '' &&
    (value.data === undefined || isPlainObject(value.data))
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// #endregion helpers
