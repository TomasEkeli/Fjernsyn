// Runs before every renderer test file (see `setupFiles` in vitest.config.mjs).
//
// The renderer is built with `process.env.IS_ELECTRON` true, so `v-safer-html`
// sanitises with Chromium's native Sanitizer API (`new Sanitizer(...)` and
// `element.setHTML(...)`), which jsdom does not have. Stand DOMPurify in for
// it, translating the Sanitizer's allow lists into DOMPurify's, so that views
// rendering instance-supplied HTML can be mounted and what survives
// sanitising can be asserted on.

import createDOMPurify from 'dompurify'

const purify = createDOMPurify(window)

// The Sanitizer allows attributes per element, DOMPurify only globally, so
// the per element lists are enforced in a hook for the duration of a call
/** @type {Map<string, Set<string>> | null} */
let attributesByElement = null

purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (attributesByElement && !attributesByElement.get(node.nodeName.toLowerCase())?.has(data.attrName)) {
    data.keepAttr = false
  }
})

if (typeof globalThis.Sanitizer === 'undefined') {
  globalThis.Sanitizer = class Sanitizer {
    constructor(config = {}) {
      this.config = config
    }
  }
}

if (typeof Element.prototype.setHTML !== 'function') {
  Element.prototype.setHTML = function setHTML(html, { sanitizer } = {}) {
    const elements = sanitizer?.config?.elements

    if (!elements) {
      this.innerHTML = purify.sanitize(html)
      return
    }

    attributesByElement = new Map(elements.map(element => typeof element === 'string'
      ? [element, new Set()]
      : [element.name, new Set(element.attributes ?? [])]))

    try {
      this.innerHTML = purify.sanitize(html, {
        ALLOWED_TAGS: [...attributesByElement.keys()],
        ALLOWED_ATTR: [...new Set([...attributesByElement.values()].flatMap(attributes => [...attributes]))],
      })
    } finally {
      attributesByElement = null
    }
  }
}
