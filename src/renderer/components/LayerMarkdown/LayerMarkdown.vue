<template>
  <!--
    A click inside a link (on its bold text, say), or a middle click, is handed
    to the link itself, because the app's handlers that open external links in
    the browser read only clicks whose target is the link. The keyboard
    reaches the link directly.
  -->
  <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events -->
  <div
    v-safer-html.lenient="html"
    class="layerMarkdown"
    dir="auto"
    @click="handleClick"
    @auxclick="handleClick"
  />
</template>

<script setup>
import { Marked } from 'marked'
import { computed } from 'vue'

import { vSaferHtml } from '../../directives/vSaferHtml'

const props = defineProps({
  /** Markdown as an instance supplied it: a description or a comment */
  source: {
    type: String,
    default: ''
  },
  /**
   * The instance the Markdown came from (`https://{host}`), for relative
   * links. Without it, relative links keep their text and lose the link.
   */
  baseUrl: {
    type: String,
    default: ''
  },
})

const LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The link's URL, absolute and normalised, when it is one a reader can
 * follow out of the app (web or mail); `null` for anything else, which is
 * every `javascript:` and `data:` URL, and a relative one with no instance
 * to resolve it against.
 *
 * @param {string | null | undefined} href
 * @param {string} baseUrl
 * @returns {string | null}
 */
function safeHref(href, baseUrl) {
  if (typeof href !== 'string' || href.trim() === '') {
    return null
  }

  try {
    const url = baseUrl ? new URL(href, baseUrl) : new URL(href)
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/**
 * @param {string} href already safe
 * @param {string | null | undefined} title
 * @param {string} innerHtml
 * @returns {string}
 */
function anchor(href, title, innerHtml) {
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(href)}"${titleAttribute}>${innerHtml}</a>`
}

/**
 * A Marked instance per base URL, so that links resolve against the instance
 * the Markdown came from.
 *
 * Raw HTML in the source is escaped, so it reads as the text it is and is
 * never parsed: an instance's `<script>`, `<style>`, event handler or `style=`
 * attribute can only ever be characters on screen. What reaches the DOM is
 * therefore only what Marked itself emits (paragraphs, emphasis, lists,
 * headings, code, quotes, tables, breaks) plus the links built here, whose
 * URLs are limited to web and mail. Images are not loaded: an image becomes a
 * link to it, as an instance's images are the instance's to track readers by.
 *
 * @param {string} baseUrl
 */
function createMarkdown(baseUrl) {
  return new Marked({
    gfm: true,
    // PeerTube renders a single newline as a line break
    breaks: true,
    renderer: {
      html({ text }) {
        return escapeHtml(text)
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        const url = safeHref(href, baseUrl)
        return url ? anchor(url, title, text) : text
      },
      image({ href, title, text }) {
        const label = escapeHtml(text || href || '')
        const url = safeHref(href, baseUrl)
        return url ? anchor(url, title, label) : label
      },
    },
  })
}

// Sanitised with `.lenient`, the sanitiser's own safe default, rather than
// the strict list (br, b, i, s, a, img), which would flatten paragraphs,
// lists and emphasis into one run of text. The escaping above already rules
// out anything the author typed as HTML, so the sanitiser is the second line,
// not the first; its default still strips scripts, handlers and `javascript:`
// URLs should anything get past Marked.
const html = computed(() => {
  if (props.source.trim() === '') {
    return ''
  }

  return createMarkdown(props.baseUrl).parse(props.source, { async: false })
})

/**
 * @param {MouseEvent} event
 */
function handleClick(event) {
  const target = /** @type {Element | null} */ (event.target)
  const link = target?.closest?.('a[href]')

  if (link && link !== target && event.currentTarget.contains(link)) {
    event.preventDefault()
    event.stopPropagation()

    if (event.type === 'click') {
      link.click()
    } else {
      link.dispatchEvent(new MouseEvent(event.type, {
        bubbles: true,
        cancelable: true,
        button: event.button,
        buttons: event.buttons,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      }))
    }
  }
}
</script>

<style scoped src="./LayerMarkdown.css" />
