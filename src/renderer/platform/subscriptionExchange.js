// Subscriptions in and out of other apps' formats, for PeerTube channel stubs.
// Pure: the data settings call these, and keep today's YouTube code as it is.
//
// NewPipe's subscription export marks each entry with a `service_id`, numbered
// by NewPipeExtractor's ServiceList (YouTube 0, SoundCloud 1, media.ccc.de 2,
// PeerTube 3, Bandcamp 4). A PeerTube entry's `url` is what NewPipeExtractor's
// PeertubeChannelLinkHandlerFactory builds: `{instance}/video-channels/{name}`
// or `{instance}/accounts/{name}`, where `{instance}` is the instance NewPipe
// is set to and `{name}` may carry the origin as `name@origin`. NewPipe
// mostly stores the account (a video's uploader link is its account's), and
// following an account means following all its videos, that is all its
// channels; Fjernsyn follows channels (its channel ref is a video channel's
// handle), so an account is resolved to its channels through the layer
// (`resolveNewPipeAccounts`, the one function here that asks anything, and
// only of the layer it is handed).

import { isNeverPeerTubeHost } from '../../peerTubeHosts.js'
import { parsePeerTubeInput } from './peertube/urls'
import { PLATFORM_PEERTUBE, isHostname, parseChannelHandle, peerTubeChannelRef, platformOf } from './refs'

export const NEWPIPE_SERVICE_YOUTUBE = 0
export const NEWPIPE_SERVICE_PEERTUBE = 3

const YOUTUBE_CHANNEL_URL_PREFIX = /https:\/\/(www\.)?youtube\.com\/channel\//

// An account's page, and its tabs: `/accounts/{name}[/...]`, `/a/{name}[/...]`
const ACCOUNT_PATH = /^\/(?:accounts|a)\/([^/]+)(?:\/.*)?$/

// How many accounts are resolved at a time
const ACCOUNT_CONCURRENCY = 2

/**
 * @typedef {object} NewPipeEntry
 * @property {number} service_id
 * @property {string} url
 * @property {string} [name]
 */

/**
 * @typedef {object} PeerTubeChannelStub
 * @property {string} id the `name@host` handle
 * @property {string} name
 * @property {string} thumbnail the avatar URL, `''` when none
 * @property {'peertube'} platform
 * @property {string} host the channel's origin
 */

/**
 * The channel stub a NewPipe subscription entry is stored as.
 *
 * A YouTube entry is recognised as today's import recognises it, by the
 * `www.youtube.com` host alone, and gives the same stub. A PeerTube entry
 * (service 3) gives a PeerTube stub when its URL is a video channel's.
 *
 * @param {NewPipeEntry | null | undefined} entry
 * @returns {{ id: string, name: string, thumbnail: null } | PeerTubeChannelStub | null}
 */
export function newPipeEntryToChannel(entry) {
  if (typeof entry?.url !== 'string') {
    return null
  }

  let hostname
  try {
    hostname = new URL(entry.url).hostname
  } catch {
    return null
  }

  if (hostname === 'www.youtube.com') {
    return {
      id: entry.url.replace(YOUTUBE_CHANNEL_URL_PREFIX, ''),
      name: entry.name,
      thumbnail: null,
    }
  }

  if (entry.service_id !== NEWPIPE_SERVICE_PEERTUBE) {
    return null
  }

  const candidate = parsePeerTubeInput(entry.url)

  if (candidate?.kind !== 'channel') {
    return null
  }

  const id = peerTubeChannelRef(candidate.name, candidate.host)

  if (id === null) {
    return null
  }

  return {
    id,
    name: typeof entry.name === 'string' ? entry.name : '',
    thumbnail: '',
    platform: PLATFORM_PEERTUBE,
    host: candidate.host,
  }
}

/**
 * The account handle (`name@origin`) of a PeerTube account URL as NewPipe
 * builds it, or `null`. Never a YouTube or Google host, as either the URL's
 * host or the origin.
 *
 * @param {string} urlText
 * @returns {string | null}
 */
function accountHandleOf(urlText) {
  let url
  try {
    url = new URL(urlText)
  } catch {
    return null
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.port !== '' || !isHostname(url.hostname) || isNeverPeerTubeHost(url.hostname)) {
    return null
  }

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname
  const match = ACCOUNT_PATH.exec(path)

  if (!match) {
    return null
  }

  let name
  try {
    name = decodeURIComponent(match[1])
  } catch {
    return null
  }

  // A remote account as another instance shows it: `/accounts/name@origin`
  const handle = name.includes('@') ? parseChannelHandle(name) : { name, host: url.hostname }

  if (handle === null || isNeverPeerTubeHost(handle.host)) {
    return null
  }

  return peerTubeChannelRef(handle.name, handle.host)
}

/**
 * What a NewPipe PeerTube entry (service 3) follows: a video channel or an
 * account, by its `name@origin` handle; `null` for anything else (another
 * service, an unreadable URL, a never-PeerTube host).
 *
 * @param {NewPipeEntry | null | undefined} entry
 * @returns {{ kind: 'channel' | 'account', handle: string } | null}
 */
export function newPipeEntryKind(entry) {
  if (entry?.service_id !== NEWPIPE_SERVICE_PEERTUBE || typeof entry.url !== 'string') {
    return null
  }

  const channel = newPipeEntryToChannel(entry)

  if (channel?.platform === PLATFORM_PEERTUBE) {
    return { kind: 'channel', handle: channel.id }
  }

  const account = accountHandleOf(entry.url)

  return account === null ? null : { kind: 'account', handle: account }
}

/**
 * The PeerTube channels in a NewPipe subscription export, the accounts to
 * resolve to their channels (each named once), and how many of its PeerTube
 * entries are neither (unreadable).
 *
 * @param {NewPipeEntry[] | undefined} entries
 * @returns {{ channels: PeerTubeChannelStub[], accounts: string[], skipped: number }}
 */
export function peerTubeChannelsFromNewPipe(entries) {
  const channels = []
  const accounts = new Set()
  let skipped = 0

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.service_id !== NEWPIPE_SERVICE_PEERTUBE) {
      continue
    }

    const kind = newPipeEntryKind(entry)

    if (kind === null) {
      skipped++
    } else if (kind.kind === 'account') {
      accounts.add(kind.handle)
    } else {
      channels.push(newPipeEntryToChannel(entry))
    }
  }

  return { channels, accounts: [...accounts], skipped }
}

/**
 * The stub a channel summary is followed as.
 *
 * @param {import('./shapes').ChannelSummary | null | undefined} summary
 * @returns {PeerTubeChannelStub | null}
 */
function stubOfSummary(summary) {
  const handle = parseChannelHandle(summary?.handle)
  const id = handle && peerTubeChannelRef(handle.name, handle.host)

  if (!id) {
    return null
  }

  return {
    id,
    name: typeof summary.name === 'string' ? summary.name : '',
    thumbnail: typeof summary.thumbnail === 'string' ? summary.thumbnail : '',
    platform: PLATFORM_PEERTUBE,
    host: handle.host,
  }
}

/**
 * Every channel of each account, as stubs, asked of the layer
 * (`listAccountChannels`) two accounts at a time. An account the layer could
 * not answer for is left out and counted. The stubs come in the accounts'
 * order, and are not deduplicated: that is the importer's, against what is
 * already followed.
 *
 * @param {string[]} accounts `name@host` handles
 * @param {{ listAccountChannels: (handle: string) => Promise<import('./shapes').ChannelSummary[]> }} layer
 * @returns {Promise<{ channels: PeerTubeChannelStub[], failed: number }>}
 */
export async function resolveNewPipeAccounts(accounts, layer) {
  /** @type {Array<PeerTubeChannelStub[] | null>} */
  const results = Array.from({ length: accounts.length }, () => null)
  let next = 0

  async function worker() {
    while (next < accounts.length) {
      const index = next++

      try {
        const summaries = await layer.listAccountChannels(accounts[index])
        results[index] = (Array.isArray(summaries) ? summaries : []).map(stubOfSummary).filter(stub => stub !== null)
      } catch {
        results[index] = null
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, accounts.length) }, worker))

  return {
    channels: results.flatMap(stubs => stubs ?? []),
    failed: results.filter(stubs => stubs === null).length,
  }
}

/**
 * Whether a profile's channel stub is YouTube's: every stub without a
 * `platform` is.
 *
 * @param {{ platform?: string }} channel
 * @returns {boolean}
 */
export function isYouTubeChannelStub(channel) {
  return platformOf(channel) !== PLATFORM_PEERTUBE
}

/**
 * The NewPipe subscription entry for a PeerTube channel stub: the channel's
 * URL on its origin, with the PeerTube service id.
 *
 * @param {PeerTubeChannelStub} stub
 * @returns {NewPipeEntry | null} null for a stub that is not a PeerTube channel's
 */
export function peerTubeStubToNewPipeEntry(stub) {
  if (platformOf(stub) !== PLATFORM_PEERTUBE) {
    return null
  }

  const handle = parseChannelHandle(stub.id)

  if (handle === null) {
    return null
  }

  return {
    service_id: NEWPIPE_SERVICE_PEERTUBE,
    url: `https://${handle.host}/video-channels/${handle.name}`,
    name: stub.name,
  }
}
