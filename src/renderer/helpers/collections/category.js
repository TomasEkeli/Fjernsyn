import { HACKERTUBE_SOURCE_ID } from './hackertube.js'
import { shareVideoKey } from './shares.js'

/*
 * The collections walls' category select: HackerTube's taxonomy, areas of
 * categories, and the wall cut down to one category. Only HackerTube gives
 * its videos categories, so a category is a question asked of HackerTube's
 * shares alone; the video stays on the wall whole, with every other source's
 * share of it, when HackerTube's share answers yes.
 */

/**
 * The wall's videos in one category, in the wall's order: those HackerTube
 * shared under it. No category is the whole wall, as it was given.
 *
 * @template {import('./shares.js').VideoRef} T
 * @param {T[]} videos the wall
 * @param {import('./shares.js').Share[]} shares every share the wall was built from
 * @param {string | null} category a category's id, or null for all
 * @returns {T[]}
 */
export function withCategory(videos, shares, category) {
  if (category === null) { return videos }

  const inCategory = new Set()
  for (const share of shares) {
    if (share.sourceId === HACKERTUBE_SOURCE_ID && Array.isArray(share.categories) && share.categories.includes(category)) {
      inCategory.add(shareVideoKey(share))
    }
  }

  return videos.filter(video => inCategory.has(shareVideoKey(video)))
}

/**
 * The category a kept choice stands for: itself while the taxonomy has it,
 * and otherwise none, as after an update that dropped it.
 *
 * @param {unknown} value
 * @param {import('./hackertube.js').HackerTubeTaxonomy | null | undefined} taxonomy
 * @returns {string | null}
 */
export function categoryOf(value, taxonomy) {
  if (typeof value !== 'string' || value === '' || !Array.isArray(taxonomy?.areas)) { return null }

  return taxonomy.areas.some(area => area.categories.some(category => category.id === value)) ? value : null
}

/**
 * The select's groups: the taxonomy's areas, in its order, each with its
 * categories; an area with none is left out.
 *
 * @param {import('./hackertube.js').HackerTubeTaxonomy | null | undefined} taxonomy
 * @returns {import('./hackertube.js').HackerTubeTaxonomy['areas']}
 */
export function categoryAreas(taxonomy) {
  if (!Array.isArray(taxonomy?.areas)) { return [] }

  return taxonomy.areas.filter(area => area.categories.length > 0)
}
