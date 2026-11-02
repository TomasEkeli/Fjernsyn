// Query parameters that only exist to tell a site, or the ad network behind it,
// where a visitor came from. Fjernsyn removes them from every link it opens,
// copies or shows. The list is kept to names with no other use, as removing a
// parameter a page needs breaks the link.

const TRACKING_PARAM_PREFIXES = ['utm_']

const TRACKING_PARAM_NAMES = new Set([
  // Google Ads, Display & Video 360, and their iOS variants
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  // Meta
  'fbclid',
  'igshid',
  'igsh',
  // Microsoft Advertising
  'msclkid',
  // Yandex
  'yclid',
  // X (Twitter)
  'twclid',
  // TikTok
  'ttclid',
  // LinkedIn
  'li_fat_id',
  // Mailchimp
  'mc_cid',
  'mc_eid',
  // HubSpot
  '_hsenc',
  '_hsmi',
  // Marketo
  'mkt_tok',
])

// `si` is a share identifier on these hosts, tying the link to whoever shared
// it. Elsewhere it is a name any site may use for itself, so it stays.
const SHARE_ID_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'open.spotify.com',
])

/**
 * @param {string} name
 * @param {string} hostname
 */
function isTrackingParam(name, hostname) {
  return TRACKING_PARAM_NAMES.has(name) ||
    TRACKING_PARAM_PREFIXES.some(prefix => name.startsWith(prefix)) ||
    (name === 'si' && SHARE_ID_HOSTS.has(hostname))
}

/**
 * Removes the tracking parameters from an http or https link.
 * Anything else, and a link with nothing to remove, is returned exactly as
 * given, as rebuilding the query would re-encode it for no reason.
 * @param {string} urlString
 * @returns {string}
 */
export function stripTrackingParams(urlString) {
  const url = URL.parse(urlString)

  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.search === '') {
    return urlString
  }

  const names = [...url.searchParams.keys()].filter(name => isTrackingParam(name, url.hostname))

  if (names.length === 0) {
    return urlString
  }

  names.forEach(name => url.searchParams.delete(name))

  return url.toString()
}
