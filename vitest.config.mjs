import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// The fork's own test runner; upstream has none. Kept to this one file and
// the `test` script so that upstream syncs have nothing to conflict on.
// Tests sit beside the module they test, as `*.test.js`, in two projects run
// by the one `pnpm test`:
//
// - `main`: the main-process modules under `src/main/` and the modules at
//   `src/` itself that both processes share, in plain Node, and
//   the build scripts' own tests under `_scripts/` (`*.test.mjs`).
// - `renderer`: renderer code under `src/renderer/`, including mounted Vue
//   components, in a simulated DOM (jsdom). It mirrors what
//   `_scripts/webpack.renderer.config.js` gives the renderer: the single file
//   component compiler, the resolve aliases, and the DefinePlugin constants.
//   Shared helpers (i18n, fake store, in-memory router, mount) are in
//   `src/renderer/testing/`.
//
// jsdom rather than happy-dom: the renderer's HTML sanitising is DOMPurify
// behind the native Sanitizer API (see `src/renderer/testing/setup.js`), and
// DOMPurify is tested upstream against jsdom. Speed does not matter at this
// size; fidelity where sanitising is concerned does.

const require = createRequire(import.meta.url)
const fromRoot = (path) => fileURLToPath(new URL(path, import.meta.url))

const ProcessLocalesPlugin = require('./_scripts/ProcessLocalesPlugin.js')
const { SHAKA_LOCALE_MAPPINGS, SHAKA_LOCALES_PREBUNDLED } = require('./_scripts/getShakaLocales.js')

const { localeNames } = new ProcessLocalesPlugin({
  inputDir: fromRoot('./static/locales'),
  outputDir: 'static/locales',
})

// The renderer's `process.env.*` constants. Vitest's `define` cannot carry
// these: it assigns them onto the real `process.env` at runtime, which turns
// every value into a string (`false` into the truthy `'false'`). So they are
// replaced in the source text instead, as webpack's DefinePlugin does.
// `process.platform` is left alone, since it is already right at runtime.
const RENDERER_CONSTANTS = {
  IS_ELECTRON: true,
  IS_ELECTRON_MAIN: false,
  SUPPORTS_LOCAL_API: true,
  LOCALE_NAMES: localeNames,
  GEOLOCATION_NAMES: readdirSync(fromRoot('./static/geolocations')).map(filename => filename.replace('.json', '')),
  SHAKA_LOCALE_MAPPINGS,
  SHAKA_LOCALES_PREBUNDLED,
  FT_SUBS_TRACE: '',
  FT_SUBS_FAIL: '',
  FT_WATCH_TRACE: '',
  FT_SUBS_BUDGET: '',
  FT_SABR_WALL: '',
  FT_COMMUNITIES_CRAWL_LIMIT: '',
  FT_COMMUNITIES_CRAWL_DELAY_MS: '',
  BUILD_STAMP: 'test',
  RELEASE_TAG: '',
}

const CONSTANT_PATTERN = new RegExp(`\\bprocess\\.env\\.(${Object.keys(RENDERER_CONSTANTS).join('|')})\\b`, 'g')
const SRC_DIR = fromRoot('./src/')

/**
 * Style blocks that name a file (`<style src="./wall.css" />`) resolve to
 * nothing, before the single file component plugin can look at them.
 *
 * `css: false` below already throws away what they compile to, so nothing is
 * lost. What is gained is that they stop crashing. The plugin finds the
 * importing component's descriptor by the stylesheet's own path, and when
 * that lookup misses it falls back to a stand-in carrying exactly one style
 * block, so the second such stylesheet in a component asks the stand-in for
 * `styles[1]` and reads a property of `undefined`. App.vue has five, and any
 * edit to the second, third or fourth (`wall.css`, `layout.css`,
 * `windowMove.css`) brings App.test.js down with a message naming neither
 * the component nor the edit.
 *
 * Only the ones with a `src` are taken: an inline `<style>` is read from the
 * component's own descriptor, which is never missing.
 *
 * @returns {import('vite').Plugin}
 */
function emptyLinkedStyleBlocks() {
  const LINKED_STYLE = /\?vue&type=style&.*&src=/

  return {
    name: 'fjernsyn:empty-linked-style-blocks',
    enforce: 'pre',

    load(id) {
      return LINKED_STYLE.test(id) ? 'export default undefined' : null
    },
  }
}

/** @returns {import('vite').Plugin} */
function rendererConstants() {
  return {
    name: 'fjernsyn:renderer-constants',
    transform(code, id) {
      if (!id.startsWith(SRC_DIR) || !code.includes('process.env.')) {
        return null
      }

      const replaced = code.replace(CONSTANT_PATTERN, (_match, name) => JSON.stringify(RENDERER_CONSTANTS[name]))

      return replaced === code ? null : { code: replaced, map: null }
    },
  }
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          include: ['src/*.test.js', 'src/main/**/*.test.js', 'src/datastores/**/*.test.js', '_scripts/**/*.test.mjs'],
          environment: 'node',
        },
      },
      {
        plugins: [
          emptyLinkedStyleBlocks(),
          vue({
            template: {
              compilerOptions: {
                isCustomElement: (tag) => tag === 'swiper-container' || tag === 'swiper-slide'
              }
            }
          }),
          rendererConstants(),
        ],
        define: {
          __VUE_OPTIONS_API__: 'true',
          __VUE_PROD_DEVTOOLS__: 'false',
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
          __VUE_I18N_LEGACY_API__: 'false',
          __VUE_I18N_FULL_INSTALL__: 'false',
          __INTLIFY_PROD_DEVTOOLS__: 'false',
        },
        resolve: {
          // As in the webpack config, less `dompurify$`: that alias drops
          // DOMPurify because Electron sanitises natively, and the test setup
          // stands DOMPurify in for the native sanitiser.
          alias: [
            { find: /^DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$/, replacement: fromRoot('./src/datastores/handlers/electron.js') },
            { find: /^youtubei\.js$/, replacement: 'youtubei.js/web' },
            { find: /^shaka-player$/, replacement: 'shaka-player/dist/shaka-player.ui-es2021.js' },
            { find: /^@fortawesome\/fontawesome-svg-core$/, replacement: fromRoot('./src/renderer/fontawesome-minimal.js') },
          ],
          extensions: ['.mjs', '.js', '.json', '.vue'],
        },
        test: {
          name: 'renderer',
          include: ['src/renderer/**/*.test.js'],
          environment: 'jsdom',
          setupFiles: ['src/renderer/testing/setup.js'],
          // CSS and SCSS, including `<style>` blocks, resolve to nothing
          css: false,
          server: {
            deps: {
              // Run through Vite, so that the fontawesome alias reaches it
              // and it shares the renderer's trimmed icon library
              inline: [/@fortawesome\/vue-fontawesome/],
            },
          },
        },
      },
    ],
  },
})
