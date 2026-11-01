/**
 * What of Communities goes into a backup (spec, "Backup"): the followed
 * sources and the shares, as two sections, `communitySources` and
 * `communityShares`, named as their datastores are, as the keeper finds a
 * section's datastore by its name.
 *
 * A source goes without what belongs to this machine: when it was last
 * refreshed, tried and failed, which change every hour and would write a
 * sync file each time while telling another machine nothing true about its
 * own refresh, and the HackerTube export this installation's shares came
 * from. HackerTube's shares stay out, as the bundle and the update rebuild
 * them; so do the shares of a source no longer followed. Details and each
 * source's own data are never sections.
 *
 * Pure, importing only its siblings by their full names, so that main (the
 * keeper) uses it as the renderer does.
 */

import { HACKERTUBE_SOURCE_ID } from './hackertube.js'

/** @import { Share, Source } from './shares.js' */

/** The fields of a source record that belong to the machine holding it */
export const SOURCE_MACHINE_FIELDS = Object.freeze(['checkedAt', 'attemptedAt', 'failedAt', 'dataGenerated'])

/**
 * A source as a backup holds it: without this machine's fields
 * @param {Record<string, any>} source
 * @returns {Record<string, any>} the same record when it has none of them
 */
export function backedUpSource(source) {
  if (!SOURCE_MACHINE_FIELDS.some(field => Object.hasOwn(source, field))) {
    return source
  }

  const record = { ...source }
  for (const field of SOURCE_MACHINE_FIELDS) {
    delete record[field]
  }
  return record
}

/**
 * A source from a backup or another machine, with this machine's own fields
 * kept from the record it holds, if it holds one
 * @param {Record<string, any>} record
 * @param {Record<string, any> | null | undefined} kept
 */
export function withMachineFields(record, kept) {
  const result = { ...backedUpSource(record) }

  if (kept != null) {
    for (const field of SOURCE_MACHINE_FIELDS) {
      if (Object.hasOwn(kept, field)) {
        result[field] = kept[field]
      }
    }
  }

  return result
}

/**
 * The two sections, from what the datastores hold
 * @param {Record<string, any>[]} sources
 * @param {Record<string, any>[]} shares
 * @returns {{ communitySources: Record<string, any>[], communityShares: Record<string, any>[] }}
 */
export function communitiesBackupSections(sources, shares) {
  const followed = new Set(sources.map(source => source._id))

  return {
    communitySources: sources.map(backedUpSource),
    communityShares: shares.filter(share => share.sourceId !== HACKERTUBE_SOURCE_ID && followed.has(share.sourceId)),
  }
}
