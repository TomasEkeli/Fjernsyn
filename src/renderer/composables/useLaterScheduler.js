import { onBeforeUnmount, watch } from 'vue'

import i18n from '../i18n/index'
import { getLocalLiveState } from '../helpers/api/local'
import { armedInOrder } from '../helpers/later'
import { effectOfAnswer, fireDecision, shouldCheck } from '../helpers/laterScheduler'
import { showToast } from '../helpers/utils'
import { isWatchPath } from '../helpers/watchRoute'

/** How often the armed items are looked at */
const TICK_MS = 30 * 1000

/** A check that failed is not tried again for this long, so a refusal is not answered with more */
const RETRY_AFTER_FAILURE_MS = 60 * 1000

/** How long the toast saying an armed event ended unseen stays */
const ENDED_TOAST_MS = 30 * 1000

/** How long a firing waits for the player of a watch page being opened */
const WAIT_FOR_PLAYER_MS = 10 * 1000

/** How long a toast saying an event went live while the window was hidden stays */
const LIVE_TOAST_MS = 60 * 1000

/**
 * The Later list's scheduler: it checks the armed items and fires those it
 * finds live. Used once, in the app shell; it acts in the main window only,
 * and only on the Local backend, as Invidious is not asked.
 *
 * Every 30 seconds each armed item is looked at, and checked when
 * `shouldCheck` says (helpers/laterScheduler.js). When each was last checked
 * is kept in memory only, so a new start checks every one at once. Checks run
 * one at a time, outside the subscription request manager (ADR-0021). A check
 * that throws is ignored, and tried again a minute later.
 *
 * An item found live fires as `fireDecision` says, one at a time, soonest
 * first. A countdown holds the others back until it is answered; a notice on
 * the player does not, and the notices stack; a desktop notification and a
 * reload are answered at once. Notices still unanswered when the watch pages
 * are left are taken down, and their items stay armed, shown as live on the
 * Later page and not fired again this run; opening one counts as going to it.
 *
 * @param {any} store
 * @param {import('vue-router').Router} router
 * @param {import('vue').Ref<boolean>} isMainWindow
 */
export function useLaterScheduler(store, router, isMainWindow) {
  /** @type {Map<string, number>} */
  const lastChecked = new Map()
  /** @type {Map<string, number>} */
  const lastFailed = new Map()
  /** @type {Set<string>} items found live and not yet answered */
  const firing = new Set()
  /** @type {string[]} found live, waiting their turn */
  const toFire = []

  // Testing only: the first check held back (FT_LATER_FIRST_CHECK_S, baked in
  // at build time), for an armed stream already live to fire while a video plays
  const notBefore = Date.now() + (Number.parseInt(process.env.FT_LATER_FIRST_CHECK_S ?? '', 10) || 0) * 1000

  let checking = false
  let firingNext = false
  let fireAgain = false
  let timer = null

  const active = () => isMainWindow.value &&
    store.getters.getLaterReady &&
    store.getters.getBackendPreference !== 'invidious' &&
    !!process.env.SUPPORTS_LOCAL_API

  const alarmOf = id => store.getters.getLaterItem(id)?.alarm ?? null

  async function tick() {
    if (checking || !active() || Date.now() < notBefore) { return }

    checking = true

    try {
      for (const { _id: id, videoId } of armedInOrder(Object.values(store.getters.getLaterItems))) {
        // Taken off, disarmed or already firing since the tick began
        const alarm = alarmOf(id)
        if (!active() || firing.has(id) || alarm == null || store.getters.getLaterIsLiveQuiet(id)) { continue }

        const now = Date.now()

        if (now - (lastFailed.get(id) ?? 0) < RETRY_AFTER_FAILURE_MS) { continue }
        if (!shouldCheck(now, alarm.at, lastChecked.get(id))) { continue }

        let answer

        try {
          answer = await getLocalLiveState(videoId)
        } catch (error) {
          lastFailed.set(id, Date.now())
          console.warn(`Later: the check of ${videoId} failed, to be tried again in a minute`, error)
          continue
        }

        lastChecked.set(id, Date.now())
        console.info(`Later: checked ${videoId}: ${answer.state}${answer.state === 'upcoming' && answer.startsAt ? ` at ${new Date(answer.startsAt).toISOString()}` : ''}`) // eslint-disable-line no-console
        await act(id, answer)
      }
    } catch (error) {
      console.error('Later: a tick of the scheduler failed', error)
    } finally {
      checking = false
    }

    fireNext()
  }

  /**
   * @param {string} id
   * @param {import('../helpers/api/liveState').LiveState} answer
   */
  async function act(id, answer) {
    // The answer may have come after the item was taken off or disarmed
    const alarm = alarmOf(id)
    if (alarm == null) { return }

    const effect = effectOfAnswer(answer, alarm.at)

    switch (effect.type) {
      case 'fire':
        firing.add(id)
        toFire.push(id)
        break

      case 'moveTime':
        await store.dispatch('updateAlarmTime', { id, at: effect.at })
        break

      case 'over': {
        const title = store.getters.getLaterItem(id)?.title ?? ''
        await store.dispatch('disarm', id)
        // Long, as it often comes at launch, while the window is still coming up
        showToast(i18n.global.t('Later.Ended unseen', { title }), ENDED_TOAST_MS)
        break
      }
    }
  }

  /**
   * Fires the soonest found live, unless a countdown is being answered. One
   * call at a time; a call while one runs makes it go round again.
   */
  async function fireNext() {
    if (firingNext) {
      fireAgain = true
      return
    }

    firingNext = true

    try {
      do {
        fireAgain = false

        while (active() && store.getters.getLaterCountdown == null && toFire.length > 0) {
          toFire.sort((a, b) => (alarmOf(a)?.at ?? 0) - (alarmOf(b)?.at ?? 0))
          await fire(toFire.shift())
        }
      } while (fireAgain)
    } finally {
      firingNext = false
    }
  }

  /** @param {string} id */
  async function fire(id) {
    const item = store.getters.getLaterItem(id)

    if (item?.alarm == null) {
      firing.delete(id)
      return
    }

    try {
      const shown = process.env.IS_ELECTRON
        ? await window.ftElectron.isWindowShown()
        : document.visibilityState === 'visible'

      // Another video's watch page whose player is not up yet is most often
      // one being opened, as when the item before was gone to: given a moment,
      // it is watching, and the notice goes on its player rather than a
      // countdown taking the viewer away from what they just chose
      if (isOnOtherWatchPage(item.videoId) && !store.getters.getLaterPlayerMounted) {
        await waitForPlayer(item.videoId)
      }

      const route = router.currentRoute.value
      const watchingVideoId = watchedVideoId(route)

      const decision = fireDecision({
        shown,
        watchingVideoId,
        // Only the layer's watch view reloads on its own (ADR-0018)
        ownPageReloads: store.getters.getEnableLayerSurfaces === true,
        playerMounted: store.getters.getLaterPlayerMounted,
      }, item.videoId)

      console.info(`Later: firing ${item.videoId}: ${decision} (shown ${shown}, on ${watchingVideoId ?? 'no watch page'}, player ${store.getters.getLaterPlayerMounted ? 'up' : 'down'})`) // eslint-disable-line no-console

      switch (decision) {
        case 'notify':
          await notify(item)
          firing.delete(id)
          break

        case 'reload':
          // A new value each time, so that the page sees a second firing of the same video
          store.commit('setLaterFiredVideo', { videoId: item.videoId, at: Date.now() })
          await store.dispatch('laterWatchNow', id)
          firing.delete(id)
          break

        case 'playerNotice':
          store.commit('addLaterNotice', item)
          break

        case 'countdown':
          store.commit('setLaterCountdown', item)
          break
      }
    } catch (error) {
      console.error(`Later: firing ${item.videoId} failed`, error)
      firing.delete(id)
    }
  }

  /** @param {string} videoId */
  function isOnOtherWatchPage(videoId) {
    const watching = watchedVideoId(router.currentRoute.value)
    return watching !== null && watching !== videoId
  }

  /**
   * Waits for a player to come up, the watch page to be left, or the time to
   * run out, whichever is first
   * @param {string} videoId the item's, whose own page is not waited on
   */
  function waitForPlayer(videoId) {
    return new Promise((resolve) => {
      let stop = null
      const done = () => {
        clearTimeout(timeout)
        stop?.()
        resolve()
      }
      const timeout = setTimeout(done, WAIT_FOR_PLAYER_MS)

      stop = watch(
        () => store.getters.getLaterPlayerMounted || !isOnOtherWatchPage(videoId),
        (ready) => { if (ready) { done() } }
      )
    })
  }

  // A countdown running when a player comes up on another video, the viewer
  // having started watching something, becomes a notice on that player: the
  // countdown would otherwise take them away from it
  watch(() => store.getters.getLaterPlayerMounted, (mounted) => {
    const countdown = store.getters.getLaterCountdown

    if (!mounted || countdown == null || !isOnOtherWatchPage(countdown.videoId)) { return }

    console.info(`Later: ${countdown.videoId} moves from the countdown to the player`) // eslint-disable-line no-console
    store.commit('addLaterNotice', countdown)
    store.commit('setLaterCountdown', null)
  })

  /**
   * The desktop notification, and the item disarmed to the top of the list,
   * where it waits whatever becomes of the notification. Where none can be
   * shown, a long toast says so instead, for when the window is seen again.
   * @param {import('../helpers/later').LaterItem} item
   */
  async function notify(item) {
    let shown = false

    if (process.env.IS_ELECTRON) {
      try {
        shown = await window.ftElectron.showLiveNotification({
          videoId: item.videoId,
          title: item.title,
          author: item.author,
          thumbnail: `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`,
        })
      } catch (error) {
        console.error('Later: the desktop notification failed', error)
      }
    }

    await store.dispatch('laterRefuse', item._id)

    if (!shown) {
      showToast(i18n.global.t('Later.Went live hidden', { title: item.title }), LIVE_TOAST_MS)
    }
  }

  // An answered notice or countdown lets its item fire again, if armed again,
  // and lets the next one through. One taken off or disarmed some other way
  // (its buttons, the Later page, another window) has its notice taken down
  watch(
    () => [
      store.getters.getLaterCountdown?._id,
      store.getters.getLaterNotices.map(item => item._id),
      store.getters.getLaterNotices.filter(item => alarmOf(item._id) == null).map(item => item._id),
    ],
    ([countdownId, noticeIds, staleIds]) => {
      for (const id of staleIds) {
        store.commit('removeLaterNotice', id)
      }

      const held = new Set(noticeIds.filter(id => !staleIds.includes(id)))
      if (countdownId != null) { held.add(countdownId) }

      for (const id of [...firing]) {
        if (!held.has(id) && !toFire.includes(id)) {
          firing.delete(id)
        }
      }

      fireNext()
    }
  )

  // Leaving the watch pages with notices unanswered quiets them (below).
  // Going from one video to the next keeps them, for the next video's player
  router.afterEach((to) => {
    // An item left live and unanswered, opened after all: gone to
    const opened = watchedVideoId(to)
    if (opened !== null && store.getters.getLaterIsLiveQuiet(opened)) {
      store.dispatch('laterWatchNow', opened)
    }

    if (isWatchPath(to.path)) { return }

    // Leaving the watch pages with notices unanswered: the items stay armed,
    // shown as live on the Later page, and are not fired again this run
    for (const item of store.getters.getLaterNotices.slice()) {
      store.commit('removeLaterNotice', item._id)
      store.commit('setLaterLiveQuiet', item._id)
    }
  })

  // A window that becomes the main one, or the list loaded, starts at once.
  // One that stops being it lets go of what it was firing, for the new main
  // window to fire
  watch(active, (isActive) => {
    if (isActive) {
      tick()
      return
    }

    if (!isMainWindow.value) {
      toFire.length = 0
      firing.clear()
      lastChecked.clear()
      store.commit('setLaterCountdown', null)

      for (const item of store.getters.getLaterNotices.slice()) {
        store.commit('removeLaterNotice', item._id)
      }
    }
  }, { immediate: true })

  // The window opened from a desktop notification: go to the item's stream
  if (process.env.IS_ELECTRON) {
    window.ftElectron.handleOpenLaterItem((videoId) => {
      router.push({ path: `/watch/${videoId}` })
      store.dispatch('removeFromLater', videoId)
    })
  }

  timer = setInterval(tick, TICK_MS)

  onBeforeUnmount(() => clearInterval(timer))
}

/**
 * The video a route's watch page is for: a YouTube id, or the PeerTube
 * video's host and uuid, which no armed item can match (a PeerTube item is
 * never armed); null off a watch page
 * @param {import('vue-router').RouteLocationNormalizedLoaded} route
 * @returns {string | null}
 */
function watchedVideoId(route) {
  if (!isWatchPath(route.path)) { return null }

  if (typeof route.params.id === 'string') { return route.params.id }

  return `peertube:${route.params.host ?? ''}/${route.params.uuid ?? ''}`
}
