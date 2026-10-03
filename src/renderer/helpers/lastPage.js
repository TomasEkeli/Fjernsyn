import { isWatchPath } from './watchRoute'

/**
 * Where the app starts: on the page the reader was last on, and on the test
 * card the first time, before there is one.
 *
 * The page is kept in localStorage rather than in the settings: it changes on
 * every navigation, which as a setting would be a database write and a sync to
 * every other window each time, and it has no business in a settings export.
 * localStorage is shared by every window, so with several open, the page last
 * moved to in any of them is the one the next start opens.
 *
 * A watch page is never remembered, so a start never plays a video by itself;
 * a reader who closed the app on one comes back to the page they came from.
 */

/**
 * The test card. The first start opens on it, and it is where the logo in the
 * top bar and a new window lead.
 */
export const HOME_PAGE = '/about'

const STORAGE_KEY = 'lastPage'

/**
 * @param {string} fullPath the route's path with its query, as `route.fullPath`
 * @param {Pick<Storage, 'setItem'>} [storage]
 */
export function rememberPage(fullPath, storage = localStorage) {
  // The bare start path is only ever on the way to the page it is replaced by
  if (fullPath === '/' || isWatchPath(fullPath)) {
    return
  }

  try {
    storage.setItem(STORAGE_KEY, fullPath)
  } catch (error) {
    console.error('Could not remember the page', error)
  }
}

/**
 * The page to open the app on: the remembered one while the app still has a
 * route for it, otherwise the home page.
 *
 * @param {import('vue-router').Router} router
 * @param {Pick<Storage, 'getItem'>} [storage]
 * @returns {string}
 */
export function pageToRestore(router, storage = localStorage) {
  let saved = null

  try {
    saved = storage.getItem(STORAGE_KEY)
  } catch (error) {
    console.error('Could not read the remembered page', error)
  }

  if (typeof saved !== 'string' || saved === '/' || isWatchPath(saved)) {
    return HOME_PAGE
  }

  return router.resolve(saved).matched.length > 0 ? saved : HOME_PAGE
}
