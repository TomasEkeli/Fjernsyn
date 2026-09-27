import { mount } from '@vue/test-utils'

import { createTestI18n } from './i18n'

/**
 * Mounts a component the way the app would host it, from the parts a test
 * gives it. i18n with the `en-US` strings is always installed; the store and
 * the router only when given. A store given here is installed for `$store`;
 * a component that imports the store module directly also needs the module
 * mocked (see `createFakeStore`).
 *
 * @param {import('vue').Component} component
 * @param {object} [options]
 * @param {import('vuex').Store<any>} [options.store]
 * @param {import('vue-router').Router} [options.router]
 * @param {import('vue-i18n').I18n} [options.i18n] defaults to a fresh `en-US` instance
 * @param {Record<string | symbol, any>} [options.provide] for `inject`, keyed as the component injects
 * @param {Record<string, any>} [options.props]
 * @param {Record<string, any>} [options.stubs] as for `@vue/test-utils`' `global.stubs`
 * @param {Record<string, any>} [options.attrs]
 */
export function mountWithApp(component, { store, router, i18n, provide, props, stubs, attrs } = {}) {
  const plugins = [i18n ?? createTestI18n()]

  if (store) {
    plugins.push(store)
  }

  if (router) {
    plugins.push(router)
  }

  return mount(component, {
    props,
    attrs,
    global: {
      plugins,
      provide,
      stubs,
    },
  })
}
