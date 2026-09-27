import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from 'js-yaml'
import { createI18n } from 'vue-i18n'

// The build turns the locale YAML into JSON (`_scripts/ProcessLocalesPlugin.js`);
// tests read the source directly. Parsed once per test file.
let enUSMessages = null

/** @returns {object} the `en-US` strings, as the app loads them */
export function loadEnUSMessages() {
  if (enUSMessages === null) {
    // Not `new URL(path, import.meta.url)`: Vite rewrites that as an asset URL
    const path = join(dirname(fileURLToPath(import.meta.url)), '../../../static/locales/en-US.yaml')
    enUSMessages = load(readFileSync(path, 'utf-8'))
  }

  return enUSMessages
}

/**
 * An i18n instance with the `en-US` strings, configured as
 * `src/renderer/i18n/index.js` configures the app's. Install it as a global
 * plugin when mounting, and both `$t` in templates and `useI18n()` in
 * `<script setup>` work.
 *
 * @example
 * mount(Component, { global: { plugins: [createTestI18n()] } })
 */
export function createTestI18n() {
  return createI18n({
    locale: 'en-US',
    legacy: false,
    fallbackLocale: 'en-US',
    messages: {
      'en-US': loadEnUSMessages(),
    },
  })
}
