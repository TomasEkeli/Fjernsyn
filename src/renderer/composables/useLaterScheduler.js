import { onBeforeUnmount, watch } from 'vue'

import i18n from '../i18n/index'
import { getLocalLiveState } from '../helpers/api/local'
import { armedInOrder } from '../helpers/later'
import { effectOfAnswer, fireDecision, shouldCheck } from '../helpers/laterScheduler'
import { showToast } from '../helpers/utils'
import { isWatchPath } from '../helpers/watchRoute'

/** How often the armed items are looked at */
const TICK_MS = 30 * 1000

/**
 * The Later list's scheduler: it checks the armed items and fires those it
 * finds live. Used once, in the app shell; it acts in the main window only,
 * and only on the Local backend, as Invidious is not asked.
 *
 * Every 30 seconds each armed item is looked at, and checked when
 * `shouldCheck` says (helpers/laterScheduler.js). When each was last checked
 * is kept in memory only, so a new start checks every one at once. Checks run
 * one at a time, outside the subscription request manager (ADR-0021). A check
 * that throws is ignored, and the next tick tries again.
 *
 * An item found live fires as `fireDecision` says. A countdown holds the
 * others back until it is answered; a notice on the player does not, and the
 * notices stack; a desktop notification and a reload are answered at once.
 *
 * @param {any} store
 * @param {import('vue-router').Router} router
 * @param {import('vue').Ref<boolean>} isMainWindow
 */
export function useLaterScheduler(store, router, isMainWindow) {
  /** @type {Map<string, number>} */
  const lastChecked = new Map()
  /** @type {Set<string>} items fired and not yet answered */
  const firing = new Set()
  /** @type {import('../helpers/later').LaterItem[]} found live, waiting their turn */
  const toFire = []

  let checking = false
  let timer = null

  const active = () => isMainWindow.value &&
    store.getters.getLaterReady &&
    store.getters.getBackendPreference !== 'invidious' &&
    !!process.env.SUPPORTS_LOCAL_API

  async function tick() {
    if (checking || !active()) { return }

    checking = true

    try {
      for (const item of armedInOrder(Object.values(store.getters.getLaterItems))) {
        // Taken off, disarmed or already firing since the tick began
        if (!active() || firing.has(item._id) || !store.getters.getIsArmed(item._id)) { continue }

        const now = Date.now()

        if (!shouldCheck(now, item.alarm.at, lastChecked.get(item._id))) { continue }

        let answer

        try {
          answer = await getLocalLiveState(item.videoId)
        } catch (error) {
          console.warn(`Later: the check of ${item.videoId} failed, to be tried on the next tick`, error)
          continue
        }

        lastChecked.set(item._id, Date.now())

        await act(item, effectOfAnswer(answer, item.alarm.at))
      }
    } finally {
      checking = false
    }

    fireNext()
  }

  /**
   * @param {import('../helpers/later').LaterItem} item
   * @param {import('../helpers/laterScheduler').CheckEffect} effect
   */
  async function act(item, effect) {
    // The answer may have come after the item was taken off or disarmed
    if (!store.getters.getIsArmed(item._id)) { return }

    switch (effect.type) {
      case 'fire':
        firing.add(item._id)
        toFire.push(store.getters.getLaterItem(item._id) ?? item)
        break

      case 'moveTime':
        await store.dispatch('updateAlarmTime', { id: item._id, at: effect.at })
        break

      case 'over':
        await store.dispatch('disarm', item._id)
        showToast(i18n.global.t('Later.Ended unseen', { title: item.title }))
        break
    }
  }

  /** Fires the soonest found live, unless a countdown is being answered */
  async function fireNext() {
    if (store.getters.getLaterCountdown != null || toFire.length === 0) { return }

    toFire.sort((a, b) => a.alarm.at - b.alarm.at)
    const item = toFire.shift()

    if (!store.getters.getIsArmed(item._id)) {
      firing.delete(item._id)
      fireNext()
      return
    }

    const shown = process.env.IS_ELECTRON
      ? await window.ftElectron.isWindowShown()
      : document.visibilityState === 'visible'

    const route = router.currentRoute.value
    const watchingVideoId = isWatchPath(route.path) && typeof route.params.id === 'string' ? route.params.id : null

    const decision = fireDecision({
      shown,
      watchingVideoId,
      // Only the layer's watch view reloads on its own (ADR-0018)
      ownPageReloads: store.getters.getEnableLayerSurfaces === true,
      playerMounted: store.getters.getLaterPlayerMounted,
    }, item.videoId)

    switch (decision) {
      case 'notify':
        if (process.env.IS_ELECTRON) {
          await window.ftElectron.showLiveNotification({
            videoId: item.videoId,
            title: item.title,
            author: item.author,
            thumbnail: `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`,
          })
        }
        await store.dispatch('laterRefuse', item._id)
        firing.delete(item._id)
        break

      case 'reload':
        store.commit('setLaterFiredVideoId', item.videoId)
        await store.dispatch('laterWatchNow', item._id)
        firing.delete(item._id)
        break

      case 'playerNotice':
        store.commit('addLaterNotice', item)
        break

      case 'countdown':
        store.commit('setLaterCountdown', item)
        break
    }

    fireNext()
  }

  // An answered notice or countdown lets its item fire again, if armed again,
  // and lets the next one through
  watch(
    () => [store.getters.getLaterCountdown?._id, store.getters.getLaterNotices.map(item => item._id)],
    ([countdownId, noticeIds]) => {
      const held = new Set(noticeIds)
      if (countdownId != null) { held.add(countdownId) }

      for (const id of [...firing]) {
        if (!held.has(id) && !toFire.some(item => item._id === id)) {
          firing.delete(id)
        }
      }

      fireNext()
    }
  )

  // A window that becomes the main one, or the list loaded, starts at once
  watch(active, (isActive) => {
    if (isActive) { tick() }
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
