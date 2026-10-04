import { DBLaterHandlers } from '../../../datastores/handlers/index'
import i18n from '../../i18n/index'
import { showToast } from '../../helpers/utils'
import {
  armedInOrder,
  laterItemFromVideo,
  moveTo,
  needsRenumbering,
  queuedInOrder,
  renumbered,
  topPosition,
} from '../../helpers/later'

/**
 * The Later list: what to watch later, in an order of its own, and the
 * upcoming events armed to start themselves when they go live. Kept in
 * `later.db`, one record per video, loaded at startup and written through on
 * every change. Each write touches one record, so that two windows, or a
 * window and the scheduler, never overwrite each other; other windows follow
 * through the sync events, which commit the same mutations without writing.
 *
 * The order and the sections are worked out in `helpers/later.js`.
 */

/** @import { LaterItem } from '../../helpers/later' */

const state = {
  /** @type {Record<string, LaterItem>} by `_id` */
  laterItems: {},
  laterReady: false,

  // Firing (composables/useLaterScheduler.js), in this window's memory only:
  /** How many video players are mounted: more than none is watching */
  laterPlayersMounted: 0,
  /** @type {LaterItem[]} armed items gone live, waiting on the player's notice */
  laterNotices: [],
  /** @type {LaterItem | null} the armed item gone live, counting down to it */
  laterCountdown: null,
  /** @type {string | null} the video whose own watch page is to reload into its stream */
  laterFiredVideoId: null,
}

const getters = {
  getLaterReady: (state) => state.laterReady,
  getLaterItems: (state) => state.laterItems,
  getLaterItem: (state) => (id) => state.laterItems[id],
  getLaterQueued: (state) => queuedInOrder(Object.values(state.laterItems)),
  getLaterArmed: (state) => armedInOrder(Object.values(state.laterItems)),
  getIsInLater: (state) => (id) => state.laterItems[id] != null,
  getIsArmed: (state) => (id) => state.laterItems[id]?.alarm != null,
  getLaterPlayerMounted: (state) => state.laterPlayersMounted > 0,
  getLaterNotices: (state) => state.laterNotices,
  getLaterCountdown: (state) => state.laterCountdown,
  getLaterFiredVideoId: (state) => state.laterFiredVideoId,
}

/**
 * @param {Record<string, LaterItem>} laterItems
 * @param {string} [except] an id left out, as for an item about to move
 */
function topOf(laterItems, except) {
  return topPosition(Object.values(laterItems).filter(item => item._id !== except))
}

const actions = {
  async grabLater({ commit }) {
    try {
      const records = await DBLaterHandlers.find()
      const laterItems = {}

      for (const record of records) {
        if (typeof record?._id === 'string' && typeof record.videoId === 'string') {
          laterItems[record._id] = {
            ...record,
            position: typeof record.position === 'number' ? record.position : 0,
            alarm: record.alarm ?? null,
          }
        }
      }

      commit('setLaterItems', laterItems)
    } catch (errMessage) {
      console.error(errMessage)
    } finally {
      commit('setLaterReady', true)
    }
  },

  /**
   * Puts a video at the top of the list, or, when it is there already, says
   * so and does nothing else.
   * @param {any} context
   * @param {any} video a card's or a watch page's video
   * @returns {Promise<boolean>} whether it was added
   */
  async addToLater({ commit, state }, video) {
    if (state.laterItems[video.videoId] != null) {
      showToast(i18n.global.t('Later.Already in Later'))
      return false
    }

    const item = laterItemFromVideo(video, Date.now())
    item.position = topOf(state.laterItems)

    commit('upsertLaterItem', item)

    try {
      await DBLaterHandlers.upsert(item)
    } catch (errMessage) {
      console.error(errMessage)
    }

    return true
  },

  /**
   * Adds every item not already there as one block above the list, in the
   * order given, keeping whatever alarm each carries. For the takeover and an
   * import.
   * @param {any} context
   * @param {LaterItem[]} items
   * @returns {Promise<{ added: number, failed: number }>}
   */
  async addManyToLater({ commit, state }, items) {
    const seen = new Set()
    const fresh = items.filter((item) => {
      if (typeof item?.videoId !== 'string' || state.laterItems[item.videoId] != null || seen.has(item.videoId)) {
        return false
      }
      seen.add(item.videoId)
      return true
    })

    const top = topOf(state.laterItems)
    let failed = 0

    for (let i = 0; i < fresh.length; i++) {
      const item = { ...fresh[i], _id: fresh[i].videoId, position: top - (fresh.length - 1 - i), alarm: fresh[i].alarm ?? null }

      try {
        await DBLaterHandlers.upsert(item)
        commit('upsertLaterItem', item)
      } catch (errMessage) {
        console.error(errMessage)
        failed++
      }
    }

    return { added: fresh.length - failed, failed }
  },

  /**
   * @param {any} context
   * @param {string} id
   */
  async removeFromLater({ commit, state }, id) {
    if (state.laterItems[id] == null) { return }

    commit('removeLaterItem', id)

    try {
      await DBLaterHandlers.delete(id)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  /**
   * Moves a queued item to a place among the others: writes its one position,
   * or every queued position once when the gaps have closed.
   * @param {any} context
   * @param {{ id: string, toIndex: number }} payload
   */
  async moveLaterItem({ commit, state }, { id, toIndex }) {
    const position = moveTo(Object.values(state.laterItems), id, toIndex)

    if (position == null) { return }

    commit('setLaterPosition', { _id: id, position })

    try {
      await DBLaterHandlers.updatePosition(id, position)

      if (needsRenumbering(Object.values(state.laterItems))) {
        for (const { _id, position: whole } of renumbered(Object.values(state.laterItems))) {
          commit('setLaterPosition', { _id, position: whole })
          await DBLaterHandlers.updatePosition(_id, whole)
        }
      }
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  /**
   * Arms an upcoming video for its stated time, adding it to the list first
   * when it is not there.
   * @param {any} context
   * @param {{ video: any, at: number }} payload
   */
  async arm({ commit, state }, { video, at }) {
    const now = Date.now()
    const alarm = { at, armedAt: now }
    const existing = state.laterItems[video.videoId]

    try {
      if (existing == null) {
        const item = laterItemFromVideo(video, now)
        item.position = topOf(state.laterItems)
        item.alarm = alarm

        commit('upsertLaterItem', item)
        await DBLaterHandlers.upsert(item)
      } else {
        commit('setLaterAlarm', { _id: existing._id, alarm })
        await DBLaterHandlers.updateAlarm(existing._id, alarm)
      }
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  /**
   * Takes the alarm off, and puts the item at the top of the queued ones.
   * @param {any} context
   * @param {string} id
   */
  async disarm({ commit, state }, id) {
    if (state.laterItems[id] == null) { return }

    const position = topOf(state.laterItems, id)

    commit('setLaterAlarm', { _id: id, alarm: null })
    commit('setLaterPosition', { _id: id, position })

    try {
      await DBLaterHandlers.updateAlarm(id, null)
      await DBLaterHandlers.updatePosition(id, position)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  /**
   * Follows a stated time that moved.
   * @param {any} context
   * @param {{ id: string, at: number }} payload
   */
  async updateAlarmTime({ commit, state }, { id, at }) {
    const alarm = state.laterItems[id]?.alarm

    if (alarm == null || alarm.at === at) { return }

    const moved = { ...alarm, at }
    commit('setLaterAlarm', { _id: id, alarm: moved })

    try {
      await DBLaterHandlers.updateAlarm(id, moved)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },
}

/**
 * Takes an item off whatever notice holds it: the player's or the countdown
 * @param {any} commit
 * @param {any} state
 * @param {string} id
 */
function clearFiring(commit, state, id) {
  commit('removeLaterNotice', id)

  if (state.laterCountdown?._id === id) {
    commit('setLaterCountdown', null)
  }
}

Object.assign(actions, {
  /**
   * An armed item gone live, gone to: it leaves the list. The caller opens
   * its watch page.
   * @param {any} context
   * @param {string} id
   */
  async laterWatchNow({ commit, dispatch, state }, id) {
    clearFiring(commit, state, id)
    await dispatch('removeFromLater', id)
  },

  /**
   * An armed item gone live, refused, dismissed, or handed to a desktop
   * notification: its alarm comes off and it waits at the top of the list.
   * @param {any} context
   * @param {string} id
   */
  async laterRefuse({ commit, dispatch, state }, id) {
    clearFiring(commit, state, id)
    await dispatch('disarm', id)
  },

  laterPlayerMounted({ commit }) {
    commit('changeLaterPlayersMounted', 1)
  },

  /**
   * A player gone: with none left, the notices it held were never answered,
   * which counts as dismissing them.
   * @param {any} context
   */
  async laterPlayerUnmounted({ commit, dispatch, state }) {
    commit('changeLaterPlayersMounted', -1)

    if (state.laterPlayersMounted > 0) { return }

    for (const item of state.laterNotices.slice()) {
      await dispatch('laterRefuse', item._id)
    }
  },
})

const mutations = {
  changeLaterPlayersMounted(state, by) {
    state.laterPlayersMounted = Math.max(0, state.laterPlayersMounted + by)
  },

  addLaterNotice(state, item) {
    if (state.laterNotices.some(notice => notice._id === item._id)) { return }

    state.laterNotices = [...state.laterNotices, item]
      .sort((a, b) => (a.alarm?.at ?? 0) - (b.alarm?.at ?? 0))
  },

  removeLaterNotice(state, id) {
    state.laterNotices = state.laterNotices.filter(notice => notice._id !== id)
  },

  setLaterCountdown(state, item) {
    state.laterCountdown = item
  },

  setLaterFiredVideoId(state, videoId) {
    state.laterFiredVideoId = videoId
  },

  setLaterReady(state, value) {
    state.laterReady = value
  },

  setLaterItems(state, laterItems) {
    state.laterItems = laterItems
  },

  upsertLaterItem(state, item) {
    state.laterItems[item._id] = item
  },

  removeLaterItem(state, id) {
    delete state.laterItems[id]
  },

  setLaterPosition(state, { _id, position }) {
    const item = state.laterItems[_id]
    if (item != null) { item.position = position }
  },

  setLaterAlarm(state, { _id, alarm }) {
    const item = state.laterItems[_id]
    if (item != null) { item.alarm = alarm }
  },
}

export default {
  state,
  getters,
  actions,
  mutations
}
