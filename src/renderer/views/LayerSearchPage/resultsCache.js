// The search page's own memory of the searches it has shown this session,
// keyed by the query's route (`routeKey`), so that the back button restores a
// page as it was, pages loaded and all, without asking again. Not shared with
// upstream's session search history, and never written to disk: a Local
// cursor is a youtubei.js instance.
//
// Also the instances searched lately, most recent first, for the source row.

const MAX_SEARCHES = 30
const MAX_INSTANCES = 5

/** @type {Map<string, object>} insertion order is age */
const searches = new Map()

/** @type {string[]} */
const instances = []

/**
 * @param {string} key
 * @returns {object | undefined}
 */
export function recall(key) {
  return searches.get(key)
}

/**
 * @param {string} key
 * @param {object} snapshot
 */
export function remember(key, snapshot) {
  searches.delete(key)
  searches.set(key, snapshot)

  while (searches.size > MAX_SEARCHES) {
    searches.delete(searches.keys().next().value)
  }
}

/**
 * @param {string} key
 */
export function forget(key) {
  searches.delete(key)
}

/**
 * @param {string} host
 */
export function rememberInstance(host) {
  const at = instances.indexOf(host)
  if (at !== -1) {
    instances.splice(at, 1)
  }

  instances.unshift(host)
  instances.length = Math.min(instances.length, MAX_INSTANCES)
}

/** @returns {string[]} */
export function recentInstances() {
  return [...instances]
}

/** Forgets everything, for tests */
export function forgetAll() {
  searches.clear()
  instances.length = 0
}
