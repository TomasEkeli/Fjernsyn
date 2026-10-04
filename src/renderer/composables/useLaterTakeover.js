import { watch } from 'vue'

import { laterItemFromVideo } from '../helpers/later'

/** The id upstream gives its built-in Watch Later playlist */
export const WATCH_LATER_PLAYLIST_ID = 'watchLater'

/**
 * The takeover: the one time move of the built-in Watch Later playlist into
 * the Later list, which replaces it.
 *
 * 1. Done before (`laterTakeoverDone`): nothing.
 * 2. No Watch Later playlist: marked done.
 * 3. Its videos are put in the Later list in the playlist's order, as a block
 *    above what the list holds, the first on top; a video already there, or
 *    met before in the playlist, is skipped. They arrive queued.
 * 4. Only when every write succeeded: a quick bookmark aimed at it moves to
 *    Favorites, or to nothing; the playlist is deleted; marked done.
 * 5. Any write failed: nothing more. Unmarked, the next start tries again,
 *    which the skip in 3 makes safe.
 *
 * The mark is why a playlist named Watch Later made after this is left alone,
 * though upstream gives it the same id on every start.
 *
 * @param {{ getters: any, dispatch: (type: string, payload?: any) => Promise<any> }} store
 * @param {number} [now]
 * @returns {Promise<'done-before' | 'nothing-to-move' | 'moved' | 'failed'>}
 */
export async function runLaterTakeover(store, now = Date.now()) {
  if (store.getters.getLaterTakeoverDone) {
    return 'done-before'
  }

  const playlist = store.getters.getPlaylist(WATCH_LATER_PLAYLIST_ID)

  if (playlist == null) {
    await store.dispatch('updateLaterTakeoverDone', true)
    return 'nothing-to-move'
  }

  const videos = (playlist.videos ?? []).filter(video => typeof video?.videoId === 'string' && video.videoId !== '')
  const youtube = videos.filter(video => video.platform == null)

  const { failed } = await store.dispatch('addManyToLater', youtube.map(video => laterItemFromVideo(video, video.timeAdded ?? now)))

  if (failed > 0) {
    return 'failed'
  }

  // The Later list holds YouTube videos only: a playlist with others in it is
  // kept, as an ordinary playlist, rather than lose them
  if (youtube.length === videos.length) {
    if (store.getters.getQuickBookmarkTargetPlaylistId === WATCH_LATER_PLAYLIST_ID) {
      const favorites = store.getters.getPlaylist('favorites')
      await store.dispatch('updateQuickBookmarkTargetPlaylistId', favorites != null ? 'favorites' : '')
    }

    await store.dispatch('removePlaylist', WATCH_LATER_PLAYLIST_ID)
  }

  await store.dispatch('updateLaterTakeoverDone', true)

  return 'moved'
}

/**
 * Runs the takeover once, in the main window only, once the playlists and
 * the Later list have loaded.
 *
 * @param {any} store
 * @param {import('vue').Ref<boolean>} isMainWindow
 */
export function useLaterTakeover(store, isMainWindow) {
  let started = false
  let stop = null

  stop = watch(
    () => isMainWindow.value && store.getters.getPlaylistsReady && store.getters.getLaterReady,
    async (ready) => {
      if (!ready || started) { return }

      started = true
      stop?.()

      try {
        await runLaterTakeover(store)
      } catch (error) {
        console.error('The Watch Later takeover failed, to be tried again on the next start', error)
      }
    },
    { immediate: true }
  )
}
