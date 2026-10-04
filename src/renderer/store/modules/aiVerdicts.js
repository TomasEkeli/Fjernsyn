import { DBAiVerdictHandlers } from '../../../datastores/handlers/index'

/**
 * The verdicts: whether YouTube labels each video "Made with AI", as far as
 * the app has found out (helpers/aiMarker). Keyed by video id, `true` for
 * `ai` and `false` for `not-ai`; a video not in it has not been asked about,
 * or its lookup failed, which is never kept.
 *
 * Kept in `ai-verdicts.db`, owned by main like every datastore, loaded here
 * at startup and written through on every new verdict, as the history is. A
 * creator declares the label at upload, so both verdicts are kept for good
 * and nothing asks about a video again. Not synced to other windows: a second
 * window learns what the first found on its next start.
 */

const state = {
  /** @type {Record<string, boolean>} video id to whether it is labelled AI */
  aiVerdicts: {},
}

const getters = {
  getAiVerdicts: (state) => state.aiVerdicts,
}

const actions = {
  async grabAiVerdicts({ commit }) {
    try {
      const records = await DBAiVerdictHandlers.find()
      const aiVerdicts = {}

      for (const record of records) {
        if (typeof record?._id === 'string' && typeof record.ai === 'boolean') {
          aiVerdicts[record._id] = record.ai
        }
      }

      commit('setAiVerdicts', aiVerdicts)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  /**
   * Keeps a video's verdict, from a lookup or from the watch page. Written
   * only when it is new or changed, since opening a video already known
   * would otherwise write the same again.
   * @param {any} context
   * @param {{ videoId: string, verdict: 'ai' | 'not-ai' }} payload
   */
  async recordAiVerdict({ commit, state }, { videoId, verdict }) {
    const ai = verdict === 'ai'

    if (state.aiVerdicts[videoId] === ai) { return }

    try {
      // Shown at once, so that the marker arrives with the answer and not
      // with the write
      commit('setAiVerdict', { videoId, ai })
      await DBAiVerdictHandlers.upsert(videoId, ai, Date.now())
    } catch (errMessage) {
      console.error(errMessage)
    }
  },
}

const mutations = {
  setAiVerdict(state, { videoId, ai }) {
    state.aiVerdicts[videoId] = ai
  },

  setAiVerdicts(state, aiVerdicts) {
    // Any found while this was loading are newer than what was on disk
    state.aiVerdicts = { ...aiVerdicts, ...state.aiVerdicts }
  },
}

export default {
  state,
  getters,
  actions,
  mutations
}
