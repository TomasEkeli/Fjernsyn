/**
 * Link recognition, shared by every source kind: a link a source shares,
 * turned into the ref of the video it is, or nothing.
 *
 * YouTube is recognised by the link alone, in every shape found in real
 * feeds: `watch?v=` on `www.`, `m.` and `music.youtube.com`, `youtu.be/`,
 * `/shorts/`, `/live/` and `/embed/` (on `youtube-nocookie.com` too).
 * Everything else is nothing: playlists, channels, hosted clips (pictrs,
 * catbox, imgchest, a bare `.mp4`), Vimeo, articles, torrents.
 *
 * PeerTube links (`/w/<id>`, `/videos/watch/<uuid>`) are nothing here as yet.
 * A link of that shape on any host may or may not be PeerTube, and only the
 * host can say, so recognising one cannot stay pure: it is to be a second
 * function beside this one, answering a candidate (host and id) for a source
 * kind's `fetch` to confirm through the platform layer, and the confirmed ref
 * then travels on the kind's item (see `kinds/lemmy.js`, `lemmyShares`).
 *
 * Framework-free and import-free.
 */

/** A YouTube video id: eleven characters of the URL-safe base64 alphabet */
const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/

/** The hosts whose `/watch?v=` is a YouTube video */
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

/** The hosts whose `/embed/<id>` is a YouTube video */
const EMBED_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'])

/** The hosts whose `/shorts/<id>` and `/live/<id>` are a YouTube video */
const PATH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])

/** The domains whose every host is YouTube's */
const YOUTUBE_DOMAINS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']

/**
 * Whether a host is one of YouTube's, any subdomain included: never a Lemmy
 * instance or any other source, whatever its paths look like.
 *
 * @param {string} host a URL's host name
 * @returns {boolean}
 */
export function isYouTubeHost(host) {
  const lower = host.toLowerCase()
  return YOUTUBE_DOMAINS.some(domain => lower === domain || lower.endsWith(`.${domain}`))
}

/**
 * @param {string | null | undefined} id
 * @returns {{ videoId: string } | null}
 */
function youTubeRef(id) {
  return typeof id === 'string' && YOUTUBE_VIDEO_ID.test(id) ? { videoId: id } : null
}

/**
 * A YouTube video's ref from a link to it, or nothing
 *
 * @param {URL} url
 * @returns {{ videoId: string } | null}
 */
function youTubeLink(url) {
  const host = url.hostname
  // The path's segments, without the empty ones a trailing or doubled slash leaves
  const path = url.pathname.split('/').filter(segment => segment !== '')

  if (host === 'youtu.be') {
    return path.length === 1 ? youTubeRef(path[0]) : null
  }

  if (WATCH_HOSTS.has(host) && path.length === 1 && path[0] === 'watch') {
    return youTubeRef(url.searchParams.get('v'))
  }

  if (path.length === 2) {
    const [kind, id] = path

    if (EMBED_HOSTS.has(host) && kind === 'embed') { return youTubeRef(id) }
    if (PATH_HOSTS.has(host) && (kind === 'shorts' || kind === 'live')) { return youTubeRef(id) }
  }

  return null
}

/**
 * The video a link is, as its ref, or nothing when it is not a link to a
 * video the app plays: only an absolute `http:` or `https:` link counts.
 *
 * @param {unknown} link
 * @returns {{ videoId: string } | null}
 */
export function videoRefFromLink(link) {
  if (typeof link !== 'string') { return null }

  let url
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') { return null }

  return youTubeLink(url)
}
