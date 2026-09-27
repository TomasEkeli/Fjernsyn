import { createStore } from 'vuex'

/**
 * A Vuex store holding only what a test gives it: getters that answer with
 * plain values, and actions and mutations that are recorded rather than run.
 *
 * Every `dispatch` is recorded in `store.dispatched` as `{ type, payload }`
 * and resolves to `undefined`; every `commit` likewise in `store.committed`.
 * `store.setGetter(name, value)` changes what a getter answers, reactively,
 * for a test of how a component follows a setting.
 *
 * Almost every component and view imports the app's store module directly
 * (`import store from '../../store/index'`) rather than calling `useStore()`,
 * so installing the fake as a plugin is not enough: the test replaces the
 * module. `vi.mock` is hoisted above the imports, so the factory builds the
 * fake itself, and the test then imports the same path to get at it:
 *
 * @example
 * import { vi } from 'vitest'
 * import store from '../../store/index'
 *
 * vi.mock('../../store/index', async () => {
 *   const { createFakeStore } = await import('../../testing/store')
 *   return { default: createFakeStore({ getters: { getListDensity: 'standard' } }) }
 * })
 *
 * // later: store.dispatched, store.setGetter('getListDensity', 'wall')
 *
 * The path in `vi.mock` is relative to the test file and must name the same
 * module the component imports. Pass the fake to `mountWithApp` (or as a
 * global plugin) as well when the component also reads `$store`.
 *
 * @param {object} [options]
 * @param {Record<string, any>} [options.getters] getter name to the value it answers
 * @param {Record<string, any>} [options.state] extra root state, if a component reads `store.state`
 */
export function createFakeStore({ getters = {}, state = {} } = {}) {
  const store = createStore({
    state: () => ({
      ...state,
      fakeGetterValues: { ...getters },
    }),
    getters: Object.fromEntries(Object.keys(getters).map(name => [
      name,
      (storeState) => storeState.fakeGetterValues[name],
    ])),
  })

  store.dispatched = []
  store.committed = []

  store.dispatch = (type, payload) => {
    store.dispatched.push(typeof type === 'object' ? { type: type.type, payload: type } : { type, payload })
    return Promise.resolve()
  }

  store.commit = (type, payload) => {
    store.committed.push(typeof type === 'object' ? { type: type.type, payload: type } : { type, payload })
  }

  store.setGetter = (name, value) => {
    if (!(name in getters)) {
      throw new Error(`createFakeStore: no getter "${name}" was given, so it cannot be set`)
    }

    store.state.fakeGetterValues[name] = value
  }

  return store
}
