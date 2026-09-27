/**
 * A federated comment's HTML (Mastodon and the like), cut down to what a
 * comment needs before it reaches the sanitising directive.
 *
 * The directive is the second line, not the first: its strict list has no
 * paragraphs and allows `<img src style>`, and its lenient one (the
 * browser's safe default) keeps images too. A remote image in a comment is a
 * tracking pixel the renderer would fetch on sight, so images go here: an
 * image becomes its alt text. An element that is not HTML (SVG, MathML) is
 * dropped whole. Everything but a short list of text elements is
 * unwrapped to its content, a list of elements whose content is not text is
 * dropped whole, and every attribute goes except a link's `href` (web and mail
 * only, absolute) and Mastodon's `invisible` and `ellipsis` classes, which
 * shorten long links as its own web client does.
 *
 * Parsed with `DOMParser`, whose document is inert: nothing in it loads or
 * runs while it is being cut down.
 */

// Text elements a comment keeps
const KEPT = new Set([
  'p', 'br', 'a', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'del',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
])

// Elements whose content is not text to read, dropped with it
const DROPPED = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'video', 'audio', 'source', 'track', 'picture', 'svg',
  'math', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'link',
  'meta', 'base', 'title', 'head',
])

const KEPT_CLASSES = new Set(['invisible', 'ellipsis'])

// Only HTML elements are kept: an SVG or MathML `a` or `style` is not what
// its name says (the roots are dropped by name too; this holds whatever the
// parser nests where)
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

const LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

/**
 * @param {string | null} href
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
 * @param {Element} element
 * @param {string | null} href the link's, already made safe
 */
function keepOnlySafeAttributes(element, href) {
  const classes = element.localName === 'span'
    ? [...element.classList].filter(className => KEPT_CLASSES.has(className))
    : []

  for (const { name } of [...element.attributes]) {
    element.removeAttribute(name)
  }

  if (href !== null) {
    element.setAttribute('href', href)
  }

  if (classes.length > 0) {
    element.setAttribute('class', classes.join(' '))
  }
}

/**
 * Cleans a node's children, deepest first, so that an element unwrapped
 * hands up children that are already clean.
 *
 * @param {Node} parent
 * @param {string} baseUrl
 */
function cleanChildren(parent, baseUrl) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) {
      continue
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      // Comments, processing instructions
      node.remove()
      continue
    }

    const element = /** @type {Element} */ (node)
    const name = element.localName

    if (element.namespaceURI !== XHTML_NAMESPACE) {
      element.remove()
      continue
    }

    if (name === 'img') {
      const alt = element.getAttribute('alt')?.trim()
      if (alt) {
        element.replaceWith(element.ownerDocument.createTextNode(alt))
      } else {
        element.remove()
      }
      continue
    }

    if (DROPPED.has(name)) {
      element.remove()
      continue
    }

    cleanChildren(element, baseUrl)

    const href = name === 'a' ? safeHref(element.getAttribute('href'), baseUrl) : null

    if (!KEPT.has(name) || (name === 'a' && href === null)) {
      element.replaceWith(...element.childNodes)
    } else {
      keepOnlySafeAttributes(element, href)
    }
  }
}

/**
 * @param {string} html a federated comment's text
 * @param {string} [baseUrl] the instance that served it, for relative links
 * @returns {string} HTML for the sanitising directive
 */
export function cleanCommentHtml(html, baseUrl = '') {
  if (typeof html !== 'string' || html.trim() === '') {
    return ''
  }

  const document = new DOMParser().parseFromString(html, 'text/html')
  cleanChildren(document.body, baseUrl)
  return document.body.innerHTML
}

// `<br>`, `<br/>`, `<br />`, in any case and with spaces before and after the
// slash; no two parts can match the same spaces, so it stays linear
const BR_TAG = /<br\s*(?:\/\s*)?>/gi

/**
 * A PeerTube comment's Markdown with each `<br>` tag made a newline.
 *
 * PeerTube's own client renders a comment's Markdown with HTML allowed, so
 * authors write `<br />` for a line break. LayerMarkdown escapes raw HTML and
 * breaks the line at a single newline (as PeerTube does), so a newline in the
 * tag's place shows the break the author meant, two in a row a new
 * paragraph, while every other tag still reads as the text it is.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function brTagsToNewlines(markdown) {
  return typeof markdown === 'string' ? markdown.replaceAll(BR_TAG, '\n') : ''
}

/**
 * A click inside a link (on a span in a Mastodon mention, say), or a middle
 * click, handed to the link itself, because the app's handlers that open
 * external links in the browser read only clicks whose target is the link.
 * As LayerMarkdown does for its own links.
 *
 * @param {MouseEvent} event
 */
export function forwardClickToLink(event) {
  const target = /** @type {Element | null} */ (event.target)
  const link = target?.closest?.('a[href]')
  const container = /** @type {Element} */ (event.currentTarget)

  if (!link || link === target || !container.contains(link)) {
    return
  }

  event.preventDefault()
  event.stopPropagation()

  if (event.type === 'click') {
    /** @type {HTMLElement} */ (link).click()
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
