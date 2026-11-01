/**
 * A Lemmy community as a source kind: its RSS feed asked, and every post in
 * it that links a video made a share.
 *
 * A community's feed is served by its home instance, at
 * `/feeds/c/<name>.xml`, as RSS 2.0, with no key and no login; another
 * instance answers 400 for a community it only federates. Each item gives
 * the post's link (`<link>`), its title, its date (`pubDate`), the link it
 * shares (`<enclosure url>`), and an HTML description: a header saying who
 * submitted it, `N points | M comments`, the shared link again, and then the
 * post's body, if it has one.
 *
 * A refresh asks for two feeds, the newest posts (`New`, for what is new) and
 * the week's top (`TopWeek`, for what rose while nobody looked), fifty each,
 * and takes each post once. Nothing a feed no longer lists is lost: shares
 * are only ever added or updated (`../shares.js`, `sharesToPut`), so a post
 * that comes back has its votes updated.
 *
 * Feeds are parsed with `DOMParser`, as the subscriptions' RSS is
 * (`helpers/subscriptions.js`), so this runs in the renderer, not in Node.
 */

import { shareId } from '../shares.js'
import { videoRefFromLink } from '../videoLinks.js'

/** @import { Share, Source } from '../shares.js' */

/**
 * @typedef {object} LemmyPost one item of a community's feed
 * @property {string} postUrl the post on the community's home instance
 * @property {string} title the post's title
 * @property {string | null} link what the post shares; null for a post of text alone
 * @property {number | null} sharedAt when it was posted, in ms
 * @property {number | null} votes its points
 * @property {string | null} why its body, as plain text, one paragraph a line
 */

/**
 * @typedef {{ name: string, host: string }} LemmyCommunity a community's name
 *   and its home instance
 */

/** The feeds asked on each refresh: the newest posts, and the week's top */
export const LEMMY_FEED_SORTS = Object.freeze(['New', 'TopWeek'])

/** How many posts each feed is asked for: the most Lemmy gives at once is fifty */
export const LEMMY_FEED_LIMIT = 50

/** A feed is some tens of KB */
const FEED_TIMEOUT_MS = 20_000

/** A community's name, as Lemmy allows it */
const COMMUNITY_NAME = /^\w+$/

/** A host name with at least one dot, which keeps `localhost` and bare words out */
const HOST_NAME = /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/

/**
 * The `N points |` of a description's header. Lemmy's wording, and so the one
 * thing here that a new Lemmy version could break without failing a request.
 */
const POINTS = /^\s*(-?\d+) points? \|/

/**
 * @param {string} name
 * @param {string} host
 * @returns {LemmyCommunity | null}
 */
function community(name, host) {
  const lowerHost = host.toLowerCase()
  return COMMUNITY_NAME.test(name) && HOST_NAME.test(lowerHost) ? { name, host: lowerHost } : null
}

/**
 * A Lemmy community, from any of the ways it is written: its page on its home
 * instance or on another (`https://lemmy.world/c/name@home`), with or without
 * `https://`; `!name@home`, and `name@home`; and its feed's URL, as an OPML
 * file writes it. Nothing for anything else. Pure: whether the instance is
 * Lemmy, and serves a feed, only asking it can tell.
 *
 * @param {string} text
 * @returns {LemmyCommunity | null}
 */
export function lemmyCommunity(text) {
  if (typeof text !== 'string') { return null }

  const trimmed = text.trim()

  const handle = /^!?(\w+)@([^@/\s]+)$/.exec(trimmed)
  if (handle !== null) { return community(handle[1], handle[2]) }

  let url
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') { return null }

  const page = /^\/c\/(\w+)(?:@([^@/]+))?\/?$/.exec(url.pathname)
  if (page !== null) { return community(page[1], page[2] ?? url.hostname) }

  const feed = /^\/feeds\/c\/(\w+)\.xml$/.exec(url.pathname)
  if (feed !== null) { return community(feed[1], url.hostname) }

  return null
}

/**
 * A community as a followed source: known by its name and home instance, its
 * name in any case being the same community, and linking to its page there.
 *
 * @param {LemmyCommunity} where
 * @param {number} followedAt
 * @returns {Source}
 */
export function lemmySource({ name, host }, followedAt) {
  return {
    _id: `lemmy:${name.toLowerCase()}@${host}`,
    kind: 'lemmy',
    url: `https://${host}/c/${name}`,
    name: `${name}@${host}`,
    followedAt,
  }
}

/**
 * @param {LemmyCommunity} where
 * @param {string} sort one of Lemmy's sorts, `New` or `TopWeek` here
 * @returns {string}
 */
export function lemmyFeedUrl({ name, host }, sort) {
  return `https://${host}/feeds/c/${name}.xml?sort=${sort}&limit=${LEMMY_FEED_LIMIT}`
}

/**
 * A post's votes: the points in its description's header, and none when the
 * header does not say, as when Lemmy has changed its wording.
 *
 * @param {string} description the item's description, as HTML
 * @returns {number | null}
 */
export function lemmyVotes(description) {
  // The header's line, after a line break, never a number in the body
  for (const line of description.split('<br>')) {
    const points = POINTS.exec(line)
    if (points !== null) { return Number(points[1]) }
  }

  return null
}

/**
 * The text of the nodes given, each paragraph on a line of its own, without
 * blank lines or runs of spaces
 *
 * @param {ChildNode[]} nodes
 * @returns {string}
 */
function plainText(nodes) {
  const lines = []

  /** @param {Node} node */
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      lines[lines.length - 1] += node.textContent
      return
    }

    const block = node.nodeName === 'P' || node.nodeName === 'LI' || node.nodeName === 'BR' || /^H\d$/.test(node.nodeName)
    if (block) { lines.push('') }
    node.childNodes.forEach(walk)
    if (block) { lines.push('') }
  }

  lines.push('')
  nodes.forEach(walk)

  return lines
    .flatMap(line => line.split('\n'))
    .map(line => line.replaceAll(/\s+/g, ' ').trim())
    .filter(line => line !== '')
    .join('\n')
}

/**
 * Why a post shared its video: its body, as plain text, which Lemmy puts after
 * the header and the shared link; nothing when it has none, or when the header
 * cannot be found and so neither can where the body begins.
 *
 * @param {string} description the item's description, as HTML
 * @returns {string | null}
 */
export function lemmyWhy(description) {
  // Inert: nothing in a parsed document loads or runs
  const nodes = [...new DOMParser().parseFromString(description, 'text/html').body.childNodes]

  const points = nodes.findIndex(node => node.nodeType === Node.TEXT_NODE && POINTS.test(node.textContent ?? ''))
  if (points === -1) { return null }

  let start = points + 1
  // The comments link closes the header's line
  if (nodes[start]?.nodeName === 'A') { start++ }
  // The shared link, as its text or as its image, on a line of its own
  if (nodes[start]?.nodeName === 'BR' && nodes[start + 1]?.nodeName === 'A') { start += 2 }

  const why = plainText(nodes.slice(start))
  return why === '' ? null : why
}

/**
 * The text of an item's first child of the name given, trimmed; null for none
 *
 * @param {Element} item
 * @param {string} name
 * @returns {string | null}
 */
function childText(item, name) {
  for (const child of item.children) {
    if (child.localName === name) {
      const text = child.textContent?.trim() ?? ''
      return text === '' ? null : text
    }
  }

  return null
}

/**
 * Every post in a community's feed, in the feed's order. An item without a
 * link to its post is left out: no share could point back to it. Throws on
 * anything that is not an RSS feed, as an instance's error page.
 *
 * @param {string} xml
 * @returns {LemmyPost[]}
 */
export function parseLemmyFeed(xml) {
  const document = new DOMParser().parseFromString(xml, 'application/xml')

  // DOMParser reports malformed input as a document holding this element
  if (document.querySelector('parsererror') !== null || document.documentElement?.localName !== 'rss') {
    throw new Error('not an RSS feed')
  }

  /** @type {LemmyPost[]} */
  const posts = []

  for (const item of document.getElementsByTagName('item')) {
    const postUrl = childText(item, 'link') ?? childText(item, 'comments') ?? childText(item, 'guid')
    if (postUrl === null) { continue }

    const enclosure = [...item.children].find(child => child.localName === 'enclosure')?.getAttribute('url')?.trim()
    const sharedAt = Date.parse(childText(item, 'pubDate') ?? '')
    const description = childText(item, 'description') ?? ''

    posts.push({
      postUrl,
      title: childText(item, 'title') ?? '',
      link: enclosure || null,
      sharedAt: Number.isFinite(sharedAt) ? sharedAt : null,
      votes: lemmyVotes(description),
      why: lemmyWhy(description),
    })
  }

  return posts
}

/**
 * The posts of several feeds of one community, each post once, by its link,
 * as the first feed to give it gave it.
 *
 * @param {LemmyPost[][]} feeds
 * @returns {LemmyPost[]}
 */
export function mergeLemmyPosts(feeds) {
  /** @type {Map<string, LemmyPost>} */
  const byPost = new Map()

  for (const posts of feeds) {
    for (const post of posts) {
      if (!byPost.has(post.postUrl)) { byPost.set(post.postUrl, post) }
    }
  }

  return [...byPost.values()]
}

/**
 * Whether post `a` speaks for its video before post `b`: more votes first,
 * then the earlier
 *
 * @param {LemmyPost} a
 * @param {LemmyPost} b
 * @returns {boolean}
 */
function before(a, b) {
  if (a.votes !== b.votes) {
    if (a.votes === null) { return false }
    if (b.votes === null) { return true }
    return a.votes > b.votes
  }

  return (a.sharedAt ?? Infinity) < (b.sharedAt ?? Infinity)
}

/**
 * A community's posts as its shares: one per video a post links, made from
 * what the post says (its title until the video's own details are known, its
 * votes, its body as the why, its date, and the post as the discussion). A
 * video posted twice is one share, the post with the most votes, the earlier
 * on a tie. Posts that link no video the app plays are skipped.
 *
 * A post links a video when `videoRefFromLink` says so of its link. When
 * PeerTube links are recognised, the kind's `fetch` will have confirmed them
 * through the platform layer, and a confirmed ref will travel on the post as
 * `ref`, to be taken before the link is read here.
 *
 * @param {LemmyPost[]} posts
 * @param {string} sourceId
 * @param {number} seenAt
 * @returns {Share[]}
 */
export function lemmyShares(posts, sourceId, seenAt) {
  /** @type {Map<string, { ref: { videoId: string }, post: LemmyPost }>} */
  const byShare = new Map()

  for (const post of posts) {
    const ref = videoRefFromLink(post.link)
    if (ref === null) { continue }

    const id = shareId(sourceId, ref)
    const kept = byShare.get(id)
    if (kept === undefined || before(post, kept.post)) {
      byShare.set(id, { ref, post })
    }
  }

  return [...byShare.entries()].map(([id, { ref, post }]) => ({
    _id: id,
    sourceId,
    videoId: ref.videoId,
    title: post.title,
    // Lemmy says who posted it, not whose channel it is
    author: '',
    votes: post.votes,
    why: post.why,
    sharedAt: post.sharedAt,
    discussionUrl: post.postUrl,
    seenAt,
  }))
}

/**
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @returns {Promise<LemmyPost[]>}
 */
async function fetchFeed(fetchFn, url) {
  const response = await fetchFn(url, { cache: 'no-cache', signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })

  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`)
  }

  try {
    return parseLemmyFeed(await response.text())
  } catch (error) {
    throw new Error(`${url}: ${error.message}`, { cause: error })
  }
}

/**
 * The community's newest posts and its week's top, each post once. Fails when
 * either feed cannot be had, so that a refresh says so; the shares kept stay.
 *
 * @param {Source} source
 * @param {{ fetch: typeof fetch }} deps
 * @returns {Promise<import('./index.js').SourceFetch>}
 */
async function fetchItems(source, { fetch: fetchFn }) {
  const where = lemmyCommunity(source.url)

  if (where === null) {
    throw new Error(`${source._id}: ${source.url} is not a Lemmy community`)
  }

  const feeds = await Promise.all(LEMMY_FEED_SORTS.map(sort => fetchFeed(fetchFn, lemmyFeedUrl(where, sort))))

  return { items: mergeLemmyPosts(feeds) }
}

/** @type {import('./index.js').SourceKind} */
export const lemmyKind = {
  kind: 'lemmy',
  recognise: (url, now) => {
    const where = lemmyCommunity(url)
    return where === null ? null : lemmySource(where, now)
  },
  fetch: fetchItems,
  toShares: (items, source, seenAt) => lemmyShares(items, source._id, seenAt),
}
