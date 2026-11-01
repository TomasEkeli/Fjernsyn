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
import { isYouTubeHost, peerTubeCandidateFromLink, videoRefFromLink } from '../videoLinks.js'

/** @import { Share, Source } from '../shares.js' */

/**
 * @typedef {object} LemmyPost one item of a community's feed
 * @property {string} postUrl the post on the community's home instance
 * @property {string} title the post's title
 * @property {string | null} link what the post shares; null for a post of text alone
 * @property {number | null} sharedAt when it was posted, in ms
 * @property {boolean} headerRead whether its description's header could be
 *   read; when not, its votes and why are unknown rather than none
 * @property {number | null} votes its points
 * @property {string | null} why its body, as plain text, one paragraph a line
 * @property {import('../../../platform/shapes').PeerTubeVideoRef | null} [ref]
 *   the PeerTube video its link is, once the platform layer has confirmed it
 *   (`fetch`); null when its link looked like one and was not, or could not
 *   be asked about; absent for any other link
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

/** PeerTube links asked about at once, of one community: each is another instance's */
const PEERTUBE_LINKS_AT_ONCE = 3

/** A community's name, as Lemmy allows it */
const COMMUNITY_NAME = /^\w+$/

/**
 * A host name with at least one dot, which keeps `localhost` and bare words
 * out, and a port if it has one
 */
const HOST = /^(?=[^:]{1,253}(?::|$))[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+(?::\d{1,5})?$/

/**
 * The `N points |` of a description's header. Lemmy's wording, and so the one
 * thing here that a new Lemmy version could break without failing a request.
 */
const POINTS = /^\s*(-?\d+) points? \|/

/**
 * @param {string} name
 * @param {string} host the host name, and its port if it has one
 * @returns {LemmyCommunity | null}
 */
function community(name, host) {
  const lowerHost = host.toLowerCase()

  if (!COMMUNITY_NAME.test(name) || !HOST.test(lowerHost)) { return null }
  // youtube.com/c/<name> is a channel
  if (isYouTubeHost(lowerHost.replace(/:\d+$/, ''))) { return null }

  return { name, host: lowerHost }
}

/**
 * A Lemmy community, from any of the ways it is written: its page on its home
 * instance or on another (`https://lemmy.world/c/name@home`), with or without
 * `https://`; `!name@home`; and its feed's URL, as an OPML file writes it.
 * Nothing for anything else: not `name@home` without the `!`, which is as
 * likely an email address or a Mastodon or PeerTube account, and nothing on
 * YouTube's hosts, whose `/c/<name>` is a channel. Pure: whether the instance
 * is Lemmy, and serves a feed, only asking it can tell.
 *
 * The name is kept as written: Lemmy looks a community up by its name in any
 * case (lemmy.cafe, Lemmy 0.19, answered `MealtimeVideos` and
 * `MEALTIMEVIDEOS` as `mealtimevideos`), so only the source's id lower-cases
 * it.
 *
 * @param {string} text
 * @returns {LemmyCommunity | null}
 */
export function lemmyCommunity(text) {
  if (typeof text !== 'string') { return null }

  const trimmed = text.trim()

  const handle = /^!(\w+)@([^@/\s]+)$/.exec(trimmed)
  if (handle !== null) { return community(handle[1], handle[2]) }

  let url
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') { return null }

  const page = /^\/c\/(\w+)(?:@([^@/]+))?\/?$/.exec(url.pathname)
  if (page !== null) { return community(page[1], page[2] ?? url.host) }

  const feed = /^\/feeds\/c\/(\w+)\.xml$/.exec(url.pathname)
  if (feed !== null) { return community(feed[1], url.host) }

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
 * What a post's description says of it, read from one parse: its votes, the
 * points in its header, and why it shared its video, its body as plain text,
 * which Lemmy puts after the header and the shared link (null when it has
 * none). Nothing when the header cannot be found, as when Lemmy has changed
 * its wording: then neither the votes nor where the body begins are known,
 * which is not the same as none.
 *
 * @param {string} description the item's description, as HTML
 * @returns {{ votes: number, why: string | null } | null}
 */
export function lemmyDescription(description) {
  // Inert: nothing in a parsed document loads or runs
  const nodes = [...new DOMParser().parseFromString(description, 'text/html').body.childNodes]

  // The header's line is a text node of the description's own, never a
  // number of points in the body, which is inside a paragraph
  const at = nodes.findIndex(node => node.nodeType === Node.TEXT_NODE && POINTS.test(node.textContent ?? ''))
  if (at === -1) { return null }

  const votes = Number(POINTS.exec(nodes[at].textContent ?? '')?.[1])

  let start = at + 1
  // The comments link closes the header's line
  if (nodes[start]?.nodeName === 'A') { start++ }
  // The shared link, as its text or as its image, on a line of its own
  if (nodes[start]?.nodeName === 'BR' && nodes[start + 1]?.nodeName === 'A') { start += 2 }

  const why = plainText(nodes.slice(start))
  return { votes, why: why === '' ? null : why }
}

/**
 * A post's votes: the points in its description's header, and none when the
 * header cannot be read (`lemmyDescription`)
 *
 * @param {string} description the item's description, as HTML
 * @returns {number | null}
 */
export function lemmyVotes(description) {
  return lemmyDescription(description)?.votes ?? null
}

/**
 * Why a post shared its video: its body, as plain text; none when it has
 * none, or when the header cannot be read (`lemmyDescription`)
 *
 * @param {string} description the item's description, as HTML
 * @returns {string | null}
 */
export function lemmyWhy(description) {
  return lemmyDescription(description)?.why ?? null
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
    const described = lemmyDescription(childText(item, 'description') ?? '')

    posts.push({
      postUrl,
      title: childText(item, 'title') ?? '',
      link: enclosure || null,
      sharedAt: Number.isFinite(sharedAt) ? sharedAt : null,
      headerRead: described !== null,
      votes: described?.votes ?? null,
      why: described?.why ?? null,
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
 * Whether post `a` speaks for its video before post `b`: more votes first
 * (a post whose votes are unknown counting as having none), then the earlier
 *
 * @param {LemmyPost} a
 * @param {LemmyPost} b
 * @returns {boolean}
 */
function before(a, b) {
  const aVotes = a.headerRead ? a.votes : null
  const bVotes = b.headerRead ? b.votes : null

  if (aVotes !== bVotes) {
    if (aVotes === null) { return false }
    if (bVotes === null) { return true }
    return aVotes > bVotes
  }

  return (a.sharedAt ?? Infinity) < (b.sharedAt ?? Infinity)
}

/**
 * A community's posts as its shares: one per video a post links, made from
 * what the post says (its title until the video's own details are known, its
 * votes, its body as the why, its date, and the post as the discussion).
 * Posts that link no video the app plays are skipped.
 *
 * A video posted more than once is one share. While the post a kept share
 * came from is still listed, it stays that post, so that the share does not
 * go back and forth as posts come and go; otherwise it is the post with the
 * most votes, the earlier on a tie.
 *
 * A post whose header could not be read gives no votes and no why: a share
 * without a field leaves the one kept as it is (`sharesToPut`, and main's
 * put), so an unreadable header never wipes what was known.
 *
 * A post links a video when `videoRefFromLink` says so of its link (YouTube),
 * or when the kind's `fetch` confirmed its link as a PeerTube video through
 * the platform layer, whose ref then travels on the post as `ref`: the
 * video's uuid and origin host, so that one video linked on two instances is
 * one share.
 *
 * @param {LemmyPost[]} posts
 * @param {string} sourceId
 * @param {number} seenAt
 * @param {Record<string, Share>} [kept] the shares kept, by `_id`
 * @returns {Share[]}
 */
export function lemmyShares(posts, sourceId, seenAt, kept = {}) {
  /** @type {Map<string, { ref: { videoId: string, platform?: string, host?: string }, post: LemmyPost }>} */
  const byShare = new Map()

  for (const post of posts) {
    const ref = post.ref ?? videoRefFromLink(post.link)
    if (ref === null) { continue }

    const id = shareId(sourceId, ref)
    const chosen = byShare.get(id)
    const keptPost = Object.hasOwn(kept, id) ? kept[id].discussionUrl : undefined

    if (chosen === undefined) {
      byShare.set(id, { ref, post })
    } else if (chosen.post.postUrl !== keptPost && (post.postUrl === keptPost || before(post, chosen.post))) {
      byShare.set(id, { ref, post })
    }
  }

  return [...byShare.entries()].map(([id, { ref, post }]) => {
    /** @type {Share} */
    const share = {
      _id: id,
      sourceId,
      videoId: ref.videoId,
      ...(ref.platform === 'peertube' ? { platform: 'peertube', host: ref.host } : {}),
      title: post.title,
      // Lemmy says who posted it, not whose channel it is
      author: '',
      votes: post.votes,
      why: post.why,
      sharedAt: post.sharedAt,
      discussionUrl: post.postUrl,
      seenAt,
    }

    if (!post.headerRead) {
      delete share.votes
      delete share.why
    }

    return share
  })
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

  let posts
  try {
    posts = parseLemmyFeed(await response.text())
  } catch (error) {
    throw new Error(`${url}: ${error.message}`, { cause: error })
  }

  // Not one header read: Lemmy has changed its wording, and every vote and
  // why would be taken for none. Failing keeps what is kept, and says so.
  if (posts.length > 0 && posts.every(post => !post.headerRead)) {
    throw new Error(`${url}: no post's header could be read; has Lemmy changed its wording?`)
  }

  return posts
}

/**
 * The posts given, those whose link has PeerTube's shape for a video with the
 * ref the platform layer confirmed it as (null when it did not), a few at a
 * time. Never fails: a link that could not be confirmed is skipped this time.
 *
 * @param {LemmyPost[]} posts
 * @param {import('./index.js').PeerTubeLinks} peertube
 * @returns {Promise<LemmyPost[]>}
 */
async function withPeerTubeRefs(posts, peertube) {
  const confirmed = [...posts]
  const asks = []

  posts.forEach((post, index) => {
    if (videoRefFromLink(post.link) !== null) { return }

    const candidate = peerTubeCandidateFromLink(post.link)
    if (candidate !== null) { asks.push({ index, candidate }) }
  })

  let next = 0

  async function work() {
    while (next < asks.length) {
      const { index, candidate } = asks[next++]
      confirmed[index] = { ...confirmed[index], ref: await peertube.refFor(candidate) }
    }
  }

  await Promise.all(Array.from({ length: Math.min(PEERTUBE_LINKS_AT_ONCE, asks.length) }, work))

  return confirmed
}

/**
 * The community's newest posts and its week's top, each post once, a link
 * that looks like a PeerTube video confirmed through the platform layer when
 * it is given (`deps.peertube`), and otherwise skipped. Fails when either
 * feed cannot be had, so that a refresh says so; the shares kept stay.
 *
 * @param {Source} source
 * @param {{ fetch: typeof fetch, peertube?: import('./index.js').PeerTubeLinks }} deps
 * @returns {Promise<import('./index.js').SourceFetch>}
 */
async function fetchItems(source, { fetch: fetchFn, peertube }) {
  const where = lemmyCommunity(source.url)

  if (where === null) {
    throw new Error(`${source._id}: ${source.url} is not a Lemmy community`)
  }

  const feeds = await Promise.all(LEMMY_FEED_SORTS.map(sort => fetchFeed(fetchFn, lemmyFeedUrl(where, sort))))
  const posts = mergeLemmyPosts(feeds)

  return { items: peertube === undefined ? posts : await withPeerTubeRefs(posts, peertube) }
}

/** @type {import('./index.js').SourceKind} */
export const lemmyKind = {
  kind: 'lemmy',
  recognise: (url, now) => {
    const where = lemmyCommunity(url)
    return where === null ? null : lemmySource(where, now)
  },
  fetch: fetchItems,
  toShares: (items, source, seenAt, kept) => lemmyShares(items, source._id, seenAt, kept),
}
