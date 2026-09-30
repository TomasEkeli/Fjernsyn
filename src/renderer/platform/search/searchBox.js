// The query a search from the search box runs, while the layer's search page
// is on: the text with the remembered set when the pill is lit, and with no
// filters when it is not. Ctrl+Enter (Cmd+Enter on macOS) runs the opposite
// of what the pill says, for that one search, without changing it. Shift is
// taken: upstream opens the search in a new window with it.
//
// Operators typed in the box (`./operators.js`) win over the set, field by
// field, and are taken out of the text.
//
// Pure; the store glue is the pill's (components/LayerSearchPill/searchBox.js).

import { parseOperators } from './operators'
import { SCOPE_YOUTUBE, defaults, normalise, withText, withoutPeerTube } from './query'

/**
 * @param {string} text what was typed
 * @param {object} options
 * @param {import('./query').SearchParameters | null} options.remembered as `readRemembered` read it
 * @param {boolean} options.latched
 * @param {boolean} [options.invert] Ctrl+Enter: the opposite of the pill, this once
 * @param {string} [options.defaultScope]
 * @param {boolean} [options.peertubeEnabled]
 * @returns {import('./query').SearchQuery}
 */
export function searchBoxQuery(text, { remembered, latched, invert = false, defaultScope = SCOPE_YOUTUBE, peertubeEnabled = false }) {
  const useSet = invert ? !latched : latched
  const base = useSet && remembered !== null ? remembered : defaults(peertubeEnabled ? defaultScope : SCOPE_YOUTUBE)
  const typed = parseOperators(text)
  const query = normalise({ ...base, ...typed.parameters, text: typed.text.trim() })

  return peertubeEnabled ? query : withoutPeerTube(query)
}

/**
 * Whether a search box event asks for the opposite of the pill.
 *
 * @param {{ ctrlKey?: boolean, metaKey?: boolean } | null | undefined} event
 * @returns {boolean}
 */
export function invertsPill(event) {
  return event?.ctrlKey === true || event?.metaKey === true
}

export { withText }
