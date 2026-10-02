// The search box's side of the layer's search page, for the top bar's
// `goToSearch`: the route a search from
// the box goes to, built from the settings (platform/search/searchBox.js), and
// the remembered set written when that search is filtered by operators typed
// in it, as any filtered search is: the new set, latched, Ctrl+Enter or not
// (typed operators are an explicit choice of filters). A search typed with operators is also
// kept in the search history as typed, operators and all, so that it can be
// run again from there; the page keeps the text it searched, as for any
// search. A channel's tag searches the same way (`layerTagSearchRoute`), but
// writes nothing.

import { parseOperators } from '../../platform/search/operators'
import { isPlain, parameters, readRemembered, sameParameters, toRoute } from '../../platform/search/query'
import { invertsPill, searchBoxQuery } from '../../platform/search/searchBox'

/**
 * @param {import('vuex').Store<any>} store
 * @param {string} text what was typed
 * @param {{ ctrlKey?: boolean, metaKey?: boolean } | null | undefined} event the search box's
 * @returns {{ path: string, query: Record<string, string> } | null} null when there is nothing
 *   to search for once the operators are taken out, and nothing is written
 */
export function layerSearchRoute(store, text, event) {
  const { getters } = store
  const peertubeEnabled = getters.getEnablePeerTube === true
  const remembered = readRemembered(getters.getSearchRememberedParameters, { peertubeEnabled })

  const query = searchBoxQuery(text, {
    remembered,
    latched: getters.getSearchLatched === true,
    invert: invertsPill(event),
    defaultScope: getters.getDefaultSearchScope,
    peertubeEnabled,
  })

  if (query.text === '') {
    return null
  }

  if (!isPlain(query) && !sameParameters(parameters(query), remembered)) {
    store.dispatch('updateSearchRememberedParameters', parameters(query))

    if (getters.getSearchLatched !== true) {
      store.dispatch('updateSearchLatched', true)
    }
  }

  const typed = text.trim()

  if (getters.getRememberSearchHistory && Object.keys(parseOperators(typed).parameters).length > 0) {
    store.dispatch('updateSearchHistoryEntry', { _id: typed, lastUpdatedAt: Date.now() })
  }

  return toRoute(query)
}

/**
 * The route of a search for one of a channel's tags (its about tab): what a
 * search for the tag typed alone in the box runs, the remembered set when the
 * pill is lit and no filters when it is not, with the tag taken as it is,
 * never read for operators. Writes nothing.
 *
 * @param {import('vuex').Store<any>} store
 * @param {string} tag
 * @returns {{ path: string, query: Record<string, string> }}
 */
export function layerTagSearchRoute(store, tag) {
  const { getters } = store
  const peertubeEnabled = getters.getEnablePeerTube === true

  const query = searchBoxQuery('', {
    remembered: readRemembered(getters.getSearchRememberedParameters, { peertubeEnabled }),
    latched: getters.getSearchLatched === true,
    defaultScope: getters.getDefaultSearchScope,
    peertubeEnabled,
  })

  return toRoute({ ...query, text: tag })
}
