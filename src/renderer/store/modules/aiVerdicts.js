/**
 * The verdicts: whether YouTube labels each video "Made with AI", as far as
 * the app has found out (helpers/aiMarker). Keyed by video id, `true` for
 * `ai` and `false` for `not-ai`; a video not in it has not been asked about,
 * or its lookup failed. A creator declares the label at upload, so a verdict
 * is kept for good and never asked about again.
 */

const state = {
  /** @type {Record<string, boolean>} video id to whether it is labelled AI */
  aiVerdicts: {},
}

const getters = {
  getAiVerdicts: (state) => state.aiVerdicts,
}

const actions = {
  /**
   * Keeps a video's verdict, from a lookup or from the watch page.
   * @param {any} context
   * @param {{ videoId: string, verdict: 'ai' | 'not-ai' }} payload
   */
  recordAiVerdict({ commit, state }, { videoId, verdict }) {
    const ai = verdict === 'ai'

    if (state.aiVerdicts[videoId] === ai) { return }

    commit('setAiVerdict', { videoId, ai })
  },
}

const mutations = {
  setAiVerdict(state, { videoId, ai }) {
    state.aiVerdicts[videoId] = ai
  },
}

export default {
  state,
  getters,
  actions,
  mutations
}
