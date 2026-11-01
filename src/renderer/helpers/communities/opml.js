/**
 * The followed sources as an OPML file, and the feeds an OPML file lists,
 * for the Sources page's export and import.
 *
 * Each source is written as one feed outline whose `xmlUrl` is its feed, as
 * its kind gives it (`SourceKind.feedUrl`: HackerTube's export URL, a Lemmy
 * community's feed on its home instance), so that a feed reader can read the
 * file, and every kind recognises its own feed URL again on import. The model
 * is the YouTube subscriptions OPML export in Data settings.
 */

import { SOURCE_KINDS_BY_KIND } from './kinds/index.js'

/** The file's title, which a feed reader may show for it */
const OPML_TITLE = 'Fjernsyn Communities sources'

/**
 * @param {string} text
 * @returns {string} the text, safe in an XML attribute or element
 */
function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

/**
 * A source's feed, as its kind gives it; its address, for a kind with no
 * feed of its own
 *
 * @param {import('./shares.js').Source} source
 * @returns {string}
 */
export function sourceFeedUrl(source) {
  return SOURCE_KINDS_BY_KIND[source.kind]?.feedUrl?.(source) ?? source.url
}

/**
 * The sources given as an OPML 2.0 document, one feed outline each, in the
 * order given
 *
 * @param {import('./shares.js').Source[]} sources
 * @returns {string}
 */
export function sourcesOpml(sources) {
  const outlines = sources.map((source) => {
    const name = escapeXml(source.name)
    return `    <outline type="rss" text="${name}" title="${name}" xmlUrl="${escapeXml(sourceFeedUrl(source))}" htmlUrl="${escapeXml(source.url)}"/>\n`
  })

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<opml version="2.0">\n' +
    `  <head>\n    <title>${escapeXml(OPML_TITLE)}</title>\n  </head>\n` +
    '  <body>\n' +
    outlines.join('') +
    '  </body>\n' +
    '</opml>\n'
}

/**
 * The feed URL of every outline in an OPML file that has one, in folders or
 * not, in the order written. Which of them name a source is for the kinds to
 * say (`recogniseSource`).
 *
 * @param {string} text the file's content
 * @returns {string[]}
 * @throws {Error} when the file is not XML, or not OPML
 */
export function opmlFeedUrls(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml')

  if (xml.querySelector('parsererror') !== null) {
    throw new Error('not an XML file')
  }
  if (xml.documentElement.nodeName.toLowerCase() !== 'opml') {
    throw new Error(`not an OPML file: its root is <${xml.documentElement.nodeName}>`)
  }

  return [...xml.querySelectorAll('body outline[xmlUrl]')]
    .map(outline => outline.getAttribute('xmlUrl').trim())
    .filter(url => url !== '')
}
