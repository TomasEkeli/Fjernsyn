import Datastore from '@seald-io/nedb'

let dbPath = null

if (process.env.IS_ELECTRON_MAIN) {
  const { app } = require('electron')
  const { join } = require('path')
  // this code only runs in the electron main process, so hopefully using sync fs code here should be fine 😬
  const { statSync, realpathSync } = require('fs')
  const userDataPath = app.getPath('userData') // This is based on the user's OS
  dbPath = (dbName) => {
    let path = join(userDataPath, `${dbName}.db`)

    // returns undefined if the path doesn't exist
    if (statSync(path, { throwIfNoEntry: false })?.isSymbolicLink) {
      path = realpathSync(path)
    }

    return path
  }
} else {
  dbPath = (dbName) => `${dbName}.db`
}

/**
 * @param {string} name
 */
function createDatastore(name) {
  return new Datastore({
    filename: dbPath(name),
    autoload: !process.env.IS_ELECTRON_MAIN,
    // Automatically clean up corrupted data, instead of crashing
    corruptAlertThreshold: 1
  })
}

export const settings = createDatastore('settings')
export const profiles = createDatastore('profiles')
export const playlists = createDatastore('playlists')
export const history = createDatastore('history')
export const searchHistory = createDatastore('search-history')
export const subscriptionCache = createDatastore('subscription-cache')
// What the app has learned about each channel, by channel id: not a cache,
// and not tied to being subscribed, so nothing clears it
export const channels = createDatastore('channels')
// Whether YouTube labels each video "Made with AI", by video id, as the AI
// lookup and the watch page found out: kept for good, so nothing clears it
export const aiVerdicts = createDatastore('ai-verdicts')
// The Later list, one record per video, by the video's ref: what to watch
// later, in an order of its own, and which upcoming events are armed
export const later = createDatastore('later')
// Collections: the followed sources, one record per source, and their
// shares, one record per source per video; a share is never dropped while
// its source is followed
export const collectionSources = createDatastore('collection-sources')
export const collectionShares = createDatastore('collection-shares')
// Collections: each collection video's own details, by the video's ref, as
// the crawl fetched them; kept apart from the shares, which stay what their
// sources said
export const collectionVideos = createDatastore('collection-videos')
// Collections: what a source has of its own besides its shares and too large
// to rewrite with its record on every refresh (HackerTube's taxonomy), one
// record per source; rebuilt from the bundle and the update, never backed up
export const collectionSourceData = createDatastore('collection-source-data')
