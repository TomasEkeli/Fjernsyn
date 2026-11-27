/**
 * Which half of a record an intent decides, and the key an intent names it by.
 *
 * An intent field is one that only an act in the app changes, and whether
 * the record is there at all. A state field is the rest: what the app worked
 * out for itself, and the video's own details. The split decides everything
 * else, so it lives in one place and no other module has a field list.
 *
 * Pure, as the backup format is, and importable from main. It imports nothing.
 *
 * A section with no intent fields is state only and keeps today's behaviour
 * exactly, so its fields are not listed, as there is nothing to partition.
 * Only `later` is evented in this part.
 */

/**
 * @typedef {object} SectionFields
 * @property {string[]} intent the fields only an intent changes, empty for a state-only section
 * @property {string[]} state the rest, listed only for an evented section
 */

const STATE_ONLY = Object.freeze({ intent: Object.freeze([]), state: Object.freeze([]) })

/**
 * Every field of an evented section's records, in one list or the other. A
 * field in neither comes back from `splitFields` named in `unknown`, so a
 * field added upstream fails the partition's test and never travels as a
 * guess.
 *
 * `videoId` is an intent field, though it is the video's own. `grabLater`
 * drops a Later record without one, and the backup's check refuses it, so an
 * event that reaches a machine before its state file would lose the record.
 *
 * @type {Readonly<Record<string, SectionFields>>}
 */
export const SECTION_FIELDS = Object.freeze({
  profiles: STATE_ONLY,
  history: STATE_ONLY,
  playlists: STATE_ONLY,
  later: Object.freeze({
    intent: Object.freeze(['_id', 'videoId', 'position', 'alarm']),
    state: Object.freeze(['title', 'author', 'authorId', 'lengthSeconds', 'viewCount', 'published', 'isUpcoming', 'premiereDate', 'addedAt', 'platform', 'host', 'thumbnail']),
  }),
  searchHistory: STATE_ONLY,
  settings: STATE_ONLY,
  channels: STATE_ONLY,
  aiVerdicts: STATE_ONLY,
  communitySources: STATE_ONLY,
  communityShares: STATE_ONLY,
})

/**
 * Whether events decide a section's records. False for a section that travels
 * as state alone.
 * @param {string} section
 */
export function isEventedSection(section) {
  return (SECTION_FIELDS[section]?.intent.length ?? 0) > 0
}

/**
 * The key an event and a state file name a record by: the section and the
 * record's id, slash separated, so that a part of a record can take a key of
 * its own later (`profiles/<profile>/<channel>`).
 * @param {string} section
 * @param {Record<string, any>} record
 * @returns {string}
 */
export function recordKey(section, record) {
  if (SECTION_FIELDS[section] === undefined) {
    throw new Error(`No such section: ${section}`)
  }

  const id = record?._id
  if (typeof id !== 'string' || id === '') {
    throw new Error(`A ${section} record with no id cannot be keyed`)
  }

  return `${section}/${id}`
}

/**
 * A record's fields in two halves, with the names of any the partition does
 * not know. A state-only section's record is state whole.
 * @param {string} section
 * @param {Record<string, any>} record
 * @returns {{ intent: Record<string, any>, state: Record<string, any>, unknown: string[] }}
 */
export function splitFields(section, record) {
  const fields = SECTION_FIELDS[section]
  if (fields === undefined) {
    throw new Error(`No such section: ${section}`)
  }

  /** @type {Record<string, any>} */
  const intent = {}
  /** @type {Record<string, any>} */
  const state = {}
  /** @type {string[]} */
  const unknown = []

  const evented = fields.intent.length > 0

  for (const [field, value] of Object.entries(record ?? {})) {
    if (!evented || fields.state.includes(field)) {
      state[field] = value
    } else if (fields.intent.includes(field)) {
      intent[field] = value
    } else {
      unknown.push(field)
    }
  }

  return { intent, state, unknown }
}
