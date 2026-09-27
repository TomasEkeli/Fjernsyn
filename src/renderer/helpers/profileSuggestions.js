/**
 * Profile suggestions: where the channels on the Channels page might belong,
 * worked out from what the app has already seen of them and nothing else.
 *
 * Two things are remembered as the app goes, at no cost in requests: the
 * YouTube category of every video watched, on its history entry, and the tags
 * of every subscribed channel whose page passes through, on its record in
 * `channels.db`. This module turns those into suggestions.
 *
 * Like `channelsOverview`, it touches no store, no i18n and no router, so the
 * rules can be checked from node, in `_scripts/checkProfileSuggestions.mjs`.
 *
 * How a suggestion is arrived at, in order, each step seeing only the
 * Unassigned channels the steps before it left:
 *
 * 1. Every subscribed channel in no profile (the pool) or in exactly one is
 *    considered. One in two or more is the duplicates UI's to settle. One
 *    put in a proposed column by hand goes there, and one whose suggestion
 *    was rejected stays where it is.
 * 2. Each profile's character is worked out from its own members. A pool
 *    channel that fits one well enough is suggested for it; a channel in a
 *    profile that fits another clearly better is a suggested move.
 * 3. A pool channel tagged with a profile's name is suggested for it.
 * 4. The rest with a category are grouped by it, and a group named as a
 *    profile is is suggested for that profile.
 * 5. A channel tagged with a category group's name joins that group.
 * 6. What is left is grouped by the tags most of it shares.
 *
 * Anything left over stays in the pool.
 */

import {
  channelMemberships,
  nonPrimaryProfiles,
  primaryProfile,
  sortChannels,
  uniqueChannels
} from './channelsOverview.js'
import { PLATFORM_YOUTUBE, platformOf } from '../platform/refs.js'

/** @import { Channel, Profile } from './channelsOverview.js' */

/*
 * The constants below were tuned by hand against Tomas's own subscriptions,
 * and the spec records what was tried. Profiles there are broad, so no one tag
 * is carried by more than a third or so of a profile's members, and the
 * thresholds are set for that.
 */

/**
 * How many of a profile's members must be known, by category or by tags,
 * before the profile is judged by that signal: fewer, and a couple of
 * channels would decide what the whole profile is. A profile just made from
 * a group of three is all one tag, and would pull in everything carrying it.
 */
export const MIN_KNOWN = 5

/** The fit an Unassigned channel needs to a profile for it to be suggested there */
export const FIT_THRESHOLD = 0.35

/**
 * The fit a channel already in a profile needs to another before a move is
 * suggested. Higher than for the pool: moving what is already filed is the
 * bigger claim, and a shared tag alone rarely makes it.
 */
export const MOVE_THRESHOLD = 0.5

/**
 * How much better a channel must fit another profile than its own before a
 * move is suggested, so that borderline channels are left alone
 */
export const MOVE_MARGIN = 0.25

/** A tag carried by fewer of a profile's members than this says nothing about it */
export const MIN_TAG_MEMBERS = 2

/** The fewest channels a tag group can have: fewer is a profile per channel */
export const MIN_TAG_GROUP = 3

/**
 * Tags so common, or so empty, that they would group channels that have
 * nothing else in common. Never counted, never grouped by.
 */
export const STOP_TAGS = new Set([
  'youtube',
  'video',
  'videos',
  'channel',
  'youtuber',
  'new',
  'official',
  // Keywords YouTube gives unquoted arrive a word at a time, and these words
  // are in everything
  'the',
  'and',
  'of',
  'to',
  'how',
  'how to',
  // What a video is, not what it is about
  'short',
  'shorts',
  'live',
  'vlog',
  'podcast',
  'tutorial',
  'tutorials',
  'review',
  'reviews'
])

/** The category Topic and artist channels are given, as YouTube names it */
export const MUSIC_CATEGORY = 'Music'

/** A channel keeps at most this many tags: some have dozens, chosen for search */
export const TAG_LIMIT = 30

/**
 * @typedef {object} ChannelTags
 * @property {string[]} tags normalised, in the order the channel gives them
 * @property {boolean} musicArtist whether it is a YouTube music artist channel
 * @property {number} [seenAt] ms since epoch, the last time the tags changed
 */

/**
 * A tag, or anything compared with one, as tags are kept: composed the same
 * way, lower case, trimmed and with every run of spaces made one.
 * @param {string} text
 * @returns {string}
 */
export function normaliseTag(text) {
  return text.normalize('NFC').toLowerCase().trim().replaceAll(/\s+/gu, ' ')
}

/**
 * A channel's keywords as YouTube gives them: one string, split on spaces,
 * with a keyword of more than one word in double quotes.
 * @param {unknown} keywords
 * @returns {string[]}
 */
function parseKeywords(keywords) {
  if (typeof keywords !== 'string') { return [] }

  const parsed = []

  for (const match of keywords.matchAll(/"([^"]*)"|(\S+)/gu)) {
    // A quote left open has no pair to end it; the stray mark goes
    parsed.push((match[1] ?? match[2]).replaceAll('"', ''))
  }

  return parsed
}

/**
 * The tags worth keeping from a channel page's metadata. The page's own tags
 * when it has any, otherwise the creator's keywords, which say much the same
 * thing in a harder form to read. Anything that cannot tell one channel from
 * another is dropped: nothing at all, a single character, a bare number, and
 * the channel's own name.
 * @param {{ tags?: unknown, keywords?: unknown, music_artist_name?: unknown } | null | undefined} metadata
 * @param {string} [channelName]
 * @returns {ChannelTags} without `seenAt`, which is for whoever stores them
 */
export function normaliseChannelTags(metadata, channelName) {
  const source = Array.isArray(metadata?.tags) && metadata.tags.length > 0
    ? metadata.tags
    : parseKeywords(metadata?.keywords)

  const ownName = typeof channelName === 'string' ? normaliseTag(channelName) : ''
  const seen = new Set()
  const tags = []

  for (const raw of source) {
    if (typeof raw !== 'string') { continue }

    const tag = normaliseTag(raw)

    if ([...tag].length < 2 || /^\p{N}+$/u.test(tag) || tag === ownName || seen.has(tag)) { continue }

    seen.add(tag)
    tags.push(tag)

    if (tags.length === TAG_LIMIT) { break }
  }

  const artistName = metadata?.music_artist_name

  return { tags, musicArtist: typeof artistName === 'string' && artistName.length > 0 }
}

/**
 * Whether newly seen tags differ from the ones kept, so that a refresh of
 * every channel writes only for the channels that changed. Reordered tags
 * count as a change, as the first matching tag decides some suggestions.
 * With nothing kept yet, nothing to keep is no change either.
 * @param {ChannelTags | null | undefined} stored
 * @param {ChannelTags} next
 * @returns {boolean}
 */
export function channelTagsChanged(stored, next) {
  if (!stored) {
    return next.tags.length > 0 || next.musicArtist
  }

  if (Boolean(stored.musicArtist) !== next.musicArtist) { return true }

  const storedTags = Array.isArray(stored.tags) ? stored.tags : []

  return storedTags.length !== next.tags.length || storedTags.some((tag, index) => tag !== next.tags[index])
}

/**
 * @typedef {object} HistoryEntry
 * @property {string} [authorId]
 * @property {string} [category]
 * @property {number} [timeWatched]
 */

/**
 * @typedef {object} WatchedCategory
 * @property {number} count how many watched videos had it
 * @property {number} lastWatched the most recent of them, ms since epoch
 */

/**
 * The categories of the videos watched from each channel: per channel id,
 * each category's count and the last time a video of it was watched. An
 * entry with no category, as every entry from before categories were
 * recorded has, or with no channel, says nothing and is skipped.
 * @param {HistoryEntry[]} historyEntries
 * @returns {Map<string, Map<string, WatchedCategory>>}
 */
export function watchedCategories(historyEntries) {
  /** @type {Map<string, Map<string, WatchedCategory>>} */
  const byChannel = new Map()

  for (const entry of historyEntries) {
    const channelId = entry.authorId
    const category = typeof entry.category === 'string' ? entry.category.trim() : ''

    if (typeof channelId !== 'string' || channelId === '' || category === '') { continue }

    let categories = byChannel.get(channelId)

    if (!categories) {
      categories = new Map()
      byChannel.set(channelId, categories)
    }

    const watchedAt = typeof entry.timeWatched === 'number' ? entry.timeWatched : 0
    const known = categories.get(category)

    if (known) {
      known.count++
      known.lastWatched = Math.max(known.lastWatched, watchedAt)
    } else {
      categories.set(category, { count: 1, lastWatched: watchedAt })
    }
  }

  return byChannel
}

/**
 * Why a channel is where it is suggested, for its tooltip. One of:
 *
 * - `watched`: its category, from `count` of its videos watched
 * - `artist`: Music, as a music artist or Topic channel
 * - `categoryShare`: its category is that of `share` (0 to 1) of the known
 *   channels in the profile
 * - `tagShare`: `count` of the `total` tagged channels in the profile share
 *   `tag` with it
 * - `tagged`: its tag `tag` names the profile or group
 * - `tags`: its first few tags, `tags`, for a tag group
 * - `placed`: put there by hand
 * - `sampled`: its category, from `count` of `total` of its recent videos
 * @typedef {{ type: 'watched', category: string, count: number }
 *   | { type: 'sampled', category: string, count: number, total: number }
 *   | { type: 'placed' }
 *   | { type: 'artist' }
 *   | { type: 'categoryShare', category: string, share: number, profileId: string }
 *   | { type: 'tagShare', tag: string, count: number, total: number, profileId: string }
 *   | { type: 'tagged', tag: string }
 *   | { type: 'tags', tags: string[] }} Evidence
 */

/**
 * @typedef {object} ChannelCategory
 * @property {string} name
 * @property {Evidence} evidence how it was decided
 */

/** How many of a channel's recent videos are looked at when probing it */
export const VIDEO_SAMPLE_SIZE = 3

/**
 * How many of a channel's sampled videos must carry a tag for it to stand in
 * for the channel's own tags: one video's tags are about that video
 */
export const MIN_SHARED_VIDEO_TAG = 2

/**
 * @typedef {object} VideoSample
 * @property {string} videoId
 * @property {string} category YouTube's category for it, empty if it gave none
 * @property {string[]} keywords its tags, normalised as channel tags are
 */

/**
 * A few of a channel's recent videos, looked at to learn what it makes, as
 * kept on its channel record. `videos` is empty for a channel that had none
 * to look at, so that it is not looked for again.
 * @typedef {object} VideoSamples
 * @property {VideoSample[]} videos newest first
 * @property {number} sampledAt ms since epoch
 */

/**
 * Whether a channel is a music artist's or a Topic channel, whose category
 * is known without looking at anything.
 * @param {Channel} channel
 * @param {ChannelTags | null | undefined} tags
 * @returns {boolean}
 */
function isMusicChannel(channel, tags) {
  return Boolean(tags?.musicArtist) || (typeof channel.name === 'string' && channel.name.endsWith(' - Topic'))
}

/**
 * Whether it is worth looking at a channel's recent videos: a YouTube channel
 * (samples come from YouTube, where another platform's handle means nothing),
 * not yet looked at, and not already known to be Music.
 * @param {Channel} channel
 * @param {ChannelTags | null | undefined} tags
 * @param {VideoSamples | null | undefined} samples
 * @returns {boolean}
 */
export function needsVideoSamples(channel, tags, samples) {
  return platformOf(channel) === PLATFORM_YOUTUBE && !Array.isArray(samples?.videos) && !isMusicChannel(channel, tags)
}

/**
 * One sampled video, as it is kept: its category trimmed, and its tags
 * normalised as a channel's are, the channel's own name among those dropped.
 * @param {string} videoId
 * @param {unknown} category
 * @param {unknown} keywords
 * @param {string} [channelName]
 * @returns {VideoSample}
 */
export function videoSample(videoId, category, keywords, channelName) {
  return {
    videoId,
    category: typeof category === 'string' ? category.trim() : '',
    keywords: normaliseChannelTags({ tags: Array.isArray(keywords) ? keywords : [] }, channelName).tags
  }
}

/**
 * The channels worth probing of all of them, in the order to probe them: the
 * pool first, as that is what most wants sorting, then the channels in one
 * profile, which make their profiles recognisable. Each alphabetically. A
 * channel in two or more profiles is left to the duplicates UI.
 * @param {Profile[]} profileList
 * @param {Record<string, ChannelTags>} channelTags
 * @param {Record<string, VideoSamples>} videoSamples
 * @param {Intl.Collator} collator
 * @returns {Channel[]}
 */
export function channelsToProbe(profileList, channelTags, videoSamples, collator) {
  const memberships = channelMemberships(profileList)
  const subscribed = sortChannels(uniqueChannels(primaryProfile(profileList)?.subscriptions ?? []), collator)
  const wanted = subscribed.filter(channel => needsVideoSamples(channel, channelTags?.[channel.id], videoSamples?.[channel.id]))

  return [
    ...wanted.filter(channel => !memberships.has(channel.id)),
    ...wanted.filter(channel => memberships.get(channel.id)?.length === 1)
  ]
}

/**
 * The tags most of a channel's sampled videos share, most shared first, for
 * a channel whose page gave none of its own.
 * @param {VideoSamples | null | undefined} samples
 * @returns {string[]}
 */
export function sharedVideoTags(samples) {
  /** @type {Map<string, number>} */
  const counts = new Map()

  for (const video of samples?.videos ?? []) {
    for (const tag of new Set(video.keywords ?? [])) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  // Sorted by count, and Map order keeps the first seen first within one
  return [...counts]
    .filter(([, count]) => count >= MIN_SHARED_VIDEO_TAG)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TAG_LIMIT)
    .map(([tag]) => tag)
}

/**
 * The category a channel is taken to be: Music for a YouTube music artist
 * channel or a Topic channel (YouTube's own, named "Someone - Topic"); failing
 * that, the category most of its watched videos had, a tie going to the one
 * watched most recently; failing that, the category most of its sampled
 * recent videos had, a tie going to the newest; failing that, none. What was
 * watched comes first, as it is what the channel is to the one watching.
 * @param {Channel} channel
 * @param {ChannelTags | null | undefined} tags
 * @param {Map<string, WatchedCategory> | null | undefined} watched this channel's, from `watchedCategories`
 * @param {VideoSamples | null | undefined} [samples]
 * @returns {ChannelCategory | null}
 */
export function channelCategory(channel, tags, watched, samples) {
  if (isMusicChannel(channel, tags)) {
    return { name: MUSIC_CATEGORY, evidence: { type: 'artist' } }
  }

  let best = null

  for (const [name, { count, lastWatched }] of watched ?? []) {
    if (best === null || count > best.count || (count === best.count && lastWatched > best.lastWatched)) {
      best = { name, count, lastWatched }
    }
  }

  if (best !== null) {
    return { name: best.name, evidence: { type: 'watched', category: best.name, count: best.count } }
  }

  const sampled = (samples?.videos ?? []).filter(video => typeof video.category === 'string' && video.category !== '')
  /** @type {Map<string, number>} in order of first seen, newest first */
  const counts = new Map()

  for (const video of sampled) {
    counts.set(video.category, (counts.get(video.category) ?? 0) + 1)
  }

  let top = null

  for (const [name, count] of counts) {
    if (top === null || count > top.count) {
      top = { name, count }
    }
  }

  if (top === null) { return null }

  return { name: top.name, evidence: { type: 'sampled', category: top.name, count: top.count, total: sampled.length } }
}

/**
 * What is known of a channel, in the form the rest of this works with.
 * @typedef {object} KnownChannel
 * @property {Channel} channel
 * @property {ChannelCategory | null} category
 * @property {string[]} tags its tags, less the stop list
 */

/**
 * The channel's own tags, or, where its page gave none, the tags its sampled
 * videos share.
 * @param {Channel} channel
 * @param {ChannelTags | null | undefined} tags
 * @param {Map<string, WatchedCategory> | null | undefined} watched
 * @param {VideoSamples | null | undefined} [samples]
 * @returns {KnownChannel}
 */
export function knownChannel(channel, tags, watched, samples) {
  const own = Array.isArray(tags?.tags) ? tags.tags : []

  return {
    channel,
    category: channelCategory(channel, tags, watched, samples),
    tags: (own.length > 0 ? own : sharedVideoTags(samples)).filter(tag => !STOP_TAGS.has(tag))
  }
}

/**
 * What a profile's members have in common, as counts: how many have each
 * category and each tag, out of how many have any. Counted once for all its
 * members, so that one member can be left out again cheaply.
 * @typedef {object} ProfileCharacter
 * @property {number} categorised members with a channel category
 * @property {Map<string, number>} categories members per category
 * @property {number} tagged members with any tags
 * @property {Map<string, number>} tags members per tag
 */

/**
 * @param {KnownChannel[]} members
 * @returns {ProfileCharacter}
 */
export function profileCharacter(members) {
  const character = { categorised: 0, categories: new Map(), tagged: 0, tags: new Map() }

  for (const member of members) {
    if (member.category !== null) {
      character.categorised++
      character.categories.set(member.category.name, (character.categories.get(member.category.name) ?? 0) + 1)
    }

    if (member.tags.length > 0) {
      character.tagged++

      for (const tag of member.tags) {
        character.tags.set(tag, (character.tags.get(tag) ?? 0) + 1)
      }
    }
  }

  return character
}

/**
 * Whether enough of a profile's members are known for it to be judged at all.
 * @param {ProfileCharacter} character
 * @returns {boolean}
 */
export function hasCharacter(character) {
  return character.categorised >= MIN_KNOWN || character.tagged >= MIN_KNOWN
}

/**
 * @typedef {object} Fit
 * @property {number} fit from 0 to 1
 * @property {Evidence | null} evidence the signal that decided it, null when nothing matched
 */

/**
 * How well a channel matches a profile's character, from 0 to 1: the larger
 * of the share of the profile's categorised members with the channel's
 * category, and the largest share of its tagged members carrying one of the
 * channel's tags. Each counts only where enough members are known for it,
 * and a tag only when more than one member carries it.
 *
 * A member is left out of its own profile's counts, so that it does not
 * vouch for itself.
 *
 * Null when neither signal can be judged: the profile has no character that
 * the channel's data can be compared with, which is not the same as a poor
 * fit.
 * @param {ProfileCharacter} character
 * @param {KnownChannel} known
 * @param {string} profileId for the evidence
 * @param {boolean} isMember
 * @returns {Fit | null}
 */
export function channelFit(character, known, profileId, isMember) {
  const self = isMember ? 1 : 0

  /** @type {Fit | null} */
  let best = null

  if (known.category !== null) {
    const categorised = character.categorised - self

    if (categorised >= MIN_KNOWN) {
      const share = ((character.categories.get(known.category.name) ?? 0) - self) / categorised

      best = {
        fit: share,
        evidence: share > 0 ? { type: 'categoryShare', category: known.category.name, share, profileId } : null
      }
    }
  }

  if (known.tags.length > 0) {
    const tagged = character.tagged - self

    if (tagged >= MIN_KNOWN) {
      let top = null

      for (const tag of known.tags) {
        const count = (character.tags.get(tag) ?? 0) - self

        if (count >= MIN_TAG_MEMBERS && (top === null || count > top.count)) {
          top = { tag, count }
        }
      }

      const share = top === null ? 0 : top.count / tagged

      // The category wins a tie, as the steadier of the two
      if (best === null || share > best.fit) {
        best = {
          fit: share,
          evidence: top === null ? null : { type: 'tagShare', tag: top.tag, count: top.count, total: tagged, profileId }
        }
      }
    }
  }

  return best
}

/**
 * Where a keep or a placement says the channel is: a profile's id, or
 * `UNASSIGNED` for the pool.
 */
export const UNASSIGNED = ''

/**
 * Tells the app a channel stays where it is, which is what rejecting its
 * suggestion means: channel id to the profile it was kept in, or `UNASSIGNED`
 * for one left in the pool. Kept as a setting, so it lasts and reaches every
 * window.
 * @typedef {Record<string, string>} Keeps
 */

/**
 * Where a channel is now: its one profile, `UNASSIGNED` in the pool, or null
 * when it is in two or more, which suggestions leave alone.
 * @param {Map<string, string[]>} memberships from `channelMemberships`
 * @param {string} channelId
 * @returns {string | null}
 */
export function channelLocation(memberships, channelId) {
  const profileIds = memberships.get(channelId)

  if (profileIds === undefined) { return UNASSIGNED }

  return profileIds.length === 1 ? profileIds[0] : null
}

/**
 * Whether a keep still applies: while the channel is where it was kept. Moved
 * anywhere since, by whatever means, it no longer does.
 * @param {Keeps | null | undefined} keeps
 * @param {Map<string, string[]>} memberships from `channelMemberships`
 * @param {string} channelId
 * @returns {boolean}
 */
export function isKept(keeps, memberships, channelId) {
  const kept = keeps?.[channelId]

  return typeof kept === 'string' && channelLocation(memberships, channelId) === kept
}

/**
 * A channel put in a proposed column by hand: the proposal's key, and where
 * the channel was when it was put there. It holds while the channel stays
 * there, so that filing it, or moving it any other way, ends it.
 * @typedef {{ key: string, from: string }} Placement
 */

/**
 * @typedef {Record<string, Placement> | Map<string, Placement>} Placements by channel id
 */

/**
 * The keeps less any that no longer apply, or the same object when all do, so
 * a caller can tell there is nothing to save. A keep that lapsed is gone for
 * good: moved back to where it was kept, the channel is suggested again.
 * @param {Keeps | null | undefined} keeps
 * @param {Map<string, string[]>} memberships
 * @returns {Keeps | null | undefined}
 */
export function pruneKeeps(keeps, memberships) {
  const ids = Object.keys(keeps ?? {})
  const applying = ids.filter(id => isKept(keeps, memberships, id))

  if (applying.length === ids.length) { return keeps }

  return Object.fromEntries(applying.map(id => [id, keeps[id]]))
}

/**
 * The keeps with one more, and any that no longer apply dropped, ready to save.
 * @param {Keeps | null | undefined} keeps
 * @param {Map<string, string[]>} memberships
 * @param {string} channelId
 * @param {string} profileId
 * @returns {Keeps}
 */
export function addKeep(keeps, memberships, channelId, profileId) {
  return { ...pruneKeeps(keeps, memberships), [channelId]: profileId }
}

/**
 * @typedef {object} SuggestedChannel
 * @property {Channel} channel
 * @property {string | null} sourceProfileId the profile it is in now, null for the pool
 * @property {Evidence} evidence
 */

/**
 * A group of channels suggested for a profile, not yet applied.
 *
 * - `profile`: for an existing profile, `profileId`
 * - `category`: a category group, for a new profile named `name`
 * - `tag`: a tag group, for a new profile named `name`
 * @typedef {object} Proposal
 * @property {string} key `profile:<id>`, `category:<name>` or `tag:<tag>`
 * @property {'profile' | 'category' | 'tag'} kind
 * @property {string} name the profile's, the category's or the tag
 * @property {string | null} profileId the target profile, for a profile proposal
 * @property {SuggestedChannel[]} channels sorted as the pool is
 */

/**
 * @typedef {object} Coverage
 * @property {number} known subscribed channels with any tags or watched category
 * @property {number} total subscribed channels
 * @property {number} profiles profiles with a character
 * @property {number} profileCount every profile but the primary one
 */

/**
 * @typedef {object} ProposeInput
 * @property {Profile[]} profileList every profile, in the user's order
 * @property {Record<string, ChannelTags> | Map<string, ChannelTags>} [channelTags] by channel id
 * @property {Map<string, Map<string, WatchedCategory>>} [watched] from `watchedCategories`
 * @property {Keeps} [keeps]
 * @property {Placements} [placements] channels put in proposed columns by hand
 * @property {Record<string, VideoSamples> | Map<string, VideoSamples>} [videoSamples] by channel id
 * @property {Intl.Collator} collator
 * @property {Set<string>} [dismissed] proposal keys dismissed this session
 */

/**
 * @typedef {object} Proposals
 * @property {Proposal[]} proposals profile proposals in profile order, then
 * category groups, then tag groups, each by size and then name
 * @property {Channel[]} remainder the pool channels no proposal took, sorted as the pool is
 * @property {Coverage} coverage
 */

/**
 * Every suggestion for the profile list as it is now. Worked out from
 * scratch each time and never stored, so it always follows the profiles.
 * @param {ProposeInput} input
 * @returns {Proposals}
 */
export function proposeProfiles({ profileList, channelTags = {}, watched = new Map(), keeps = {}, placements = {}, videoSamples = {}, collator, dismissed = new Set() }) {
  const memberships = channelMemberships(profileList)
  const profiles = nonPrimaryProfiles(profileList)
  const subscribed = uniqueChannels(primaryProfile(profileList)?.subscriptions ?? [])

  // A plain read, which a reactive store object notices even for a channel
  // it has nothing for yet, so tags arriving later are picked up
  const tagsOf = channelTags instanceof Map
    ? id => channelTags.get(id)
    : id => channelTags?.[id]
  const samplesOf = videoSamples instanceof Map
    ? id => videoSamples.get(id)
    : id => videoSamples?.[id]

  /** @type {Map<string, KnownChannel>} */
  const known = new Map()
  let knownCount = 0

  for (const channel of subscribed) {
    const tags = tagsOf(channel.id)
    const watchedHere = watched.get(channel.id)

    const samples = samplesOf(channel.id)

    known.set(channel.id, knownChannel(channel, tags, watchedHere, samples))

    const sampledSomething = (samples?.videos ?? []).some(video => video.category !== '' || video.keywords?.length > 0)

    if ((Array.isArray(tags?.tags) && tags.tags.length > 0) || tags?.musicArtist || (watchedHere?.size ?? 0) > 0 || sampledSomething) {
      knownCount++
    }
  }

  // Each profile's character, from its members in no other profile
  /** @type {Map<string, ProfileCharacter>} */
  const characters = new Map()

  for (const profile of profiles) {
    const members = []

    for (const channel of uniqueChannels(profile.subscriptions)) {
      const member = known.get(channel.id)

      if (member && memberships.get(channel.id)?.length === 1) {
        members.push(member)
      }
    }

    const character = profileCharacter(members)

    if (hasCharacter(character)) {
      characters.set(profile._id, character)
    }
  }

  /** @type {Map<string, Proposal>} */
  const byKey = new Map()

  /**
   * @param {string} key
   * @param {Proposal['kind']} kind
   * @param {string} name
   * @param {string | null} profileId
   * @returns {Proposal}
   */
  function proposal(key, kind, name, profileId) {
    let found = byKey.get(key)

    if (!found) {
      found = { key, kind, name, profileId, channels: [] }
      byKey.set(key, found)
    }

    return found
  }

  const profileNames = new Map()

  for (const profile of profiles) {
    const name = normaliseTag(profile.name ?? '')

    if (name !== '' && !profileNames.has(name)) {
      profileNames.set(name, profile)
    }
  }

  /**
   * @param {Profile} profile
   * @returns {Proposal}
   */
  const profileProposal = profile => proposal(`profile:${profile._id}`, 'profile', profile.name, profile._id)

  /**
   * The best fit among the profiles with a character, a tie going to the
   * earlier profile.
   * @param {KnownChannel} channel
   * @param {string | null} ownProfileId left out
   * @returns {{ profile: Profile, fit: Fit } | null}
   */
  function bestFit(channel, ownProfileId) {
    let best = null

    for (const profile of profiles) {
      if (profile._id === ownProfileId) { continue }

      const character = characters.get(profile._id)

      if (!character) { continue }

      const fit = channelFit(character, channel, profile._id, false)

      if (fit !== null && fit.evidence !== null && (best === null || fit.fit > best.fit.fit)) {
        best = { profile, fit }
      }
    }

    return best
  }

  /** @type {Map<string, Proposal>} by the category's name as tags are kept */
  const categoryGroups = new Map()

  /**
   * The proposal a placement names, as it stands now. A new group named as a
   * profile is by now that profile's, as when a group has just been made one.
   * @param {string} key
   * @returns {Proposal | null}
   */
  function placedProposal(key) {
    const colon = key.indexOf(':')
    const kind = key.slice(0, colon)
    const name = key.slice(colon + 1)

    if (kind === 'profile') {
      const profile = profiles.find(candidate => candidate._id === name)

      return profile ? profileProposal(profile) : null
    }

    if (kind !== 'category' && kind !== 'tag') { return null }

    const profile = profileNames.get(normaliseTag(name))

    if (profile) { return profileProposal(profile) }

    if (kind === 'tag') { return proposal(key, 'tag', name, null) }

    const normalised = normaliseTag(name)
    let group = categoryGroups.get(normalised)

    if (!group) {
      group = proposal(key, 'category', name, null)
      categoryGroups.set(normalised, group)
    }

    return group
  }

  const placementOf = placements instanceof Map
    ? id => placements.get(id)
    : id => placements?.[id]

  /** @type {Set<string>} */
  const placedByHand = new Set()

  // 1. By hand, before anything is worked out, for as long as the channel
  // stays where it was put there from
  for (const channel of subscribed) {
    const placement = placementOf(channel.id)

    if (!placement || typeof placement.key !== 'string') { continue }

    const location = channelLocation(memberships, channel.id)

    if (location === null || location !== placement.from) { continue }

    const target = placedProposal(placement.key)

    if (target === null || target.profileId === location) { continue }

    target.channels.push({ channel, sourceProfileId: location === UNASSIGNED ? null : location, evidence: { type: 'placed' } })
    placedByHand.add(channel.id)
  }

  /** @type {KnownChannel[]} */
  let left = []

  // 2. Fit against the profiles, for the pool and for the channels in one.
  // A channel kept where it is, as its suggestion was rejected, is left there.
  for (const channel of subscribed) {
    if (placedByHand.has(channel.id) || isKept(keeps, memberships, channel.id)) { continue }

    const entry = known.get(channel.id)
    const profileIds = memberships.get(channel.id)

    if (profileIds === undefined) {
      const best = bestFit(entry, null)

      if (best !== null && best.fit.fit >= FIT_THRESHOLD) {
        profileProposal(best.profile).channels.push({ channel, sourceProfileId: null, evidence: best.fit.evidence })
      } else {
        left.push(entry)
      }
    } else if (profileIds.length === 1) {
      const ownId = profileIds[0]
      const ownCharacter = characters.get(ownId)

      if (!ownCharacter) { continue }

      const own = channelFit(ownCharacter, entry, ownId, true)

      if (own === null) { continue }

      const best = bestFit(entry, ownId)

      if (best !== null && best.fit.fit >= MOVE_THRESHOLD && own.fit <= best.fit.fit - MOVE_MARGIN + 1e-9) {
        profileProposal(best.profile).channels.push({ channel, sourceProfileId: ownId, evidence: best.fit.evidence })
      }
    }
  }

  // 3. A tag naming a profile, the first such tag deciding
  left = left.filter(entry => {
    for (const tag of entry.tags) {
      const profile = profileNames.get(tag)

      if (profile) {
        profileProposal(profile).channels.push({ channel: entry.channel, sourceProfileId: null, evidence: { type: 'tagged', tag } })
        return false
      }
    }

    return true
  })

  // 4. By category, a category named as a profile is going to that profile.
  // Categories that differ only in case or spacing are one group, under the
  // name first seen.

  left = left.filter(entry => {
    if (entry.category === null) { return true }

    const { name, evidence } = entry.category
    const normalised = normaliseTag(name)
    const profile = profileNames.get(normalised)
    const suggested = { channel: entry.channel, sourceProfileId: null, evidence }

    if (profile) {
      profileProposal(profile).channels.push(suggested)
    } else {
      let group = categoryGroups.get(normalised)

      if (!group) {
        group = proposal(`category:${name}`, 'category', name, null)
        categoryGroups.set(normalised, group)
      }

      group.channels.push(suggested)
    }

    return false
  })

  // 5. A tag naming a category group, the first such tag deciding
  left = left.filter(entry => {
    for (const tag of entry.tags) {
      const group = categoryGroups.get(tag)

      if (group) {
        group.channels.push({ channel: entry.channel, sourceProfileId: null, evidence: { type: 'tagged', tag } })
        return false
      }
    }

    return true
  })

  // 6. Tag groups, the tag the most of what is left shares first
  const candidates = new Set(left.filter(entry => entry.tags.length > 0))
  /** @type {Map<string, number>} */
  const tagCounts = new Map()

  for (const entry of candidates) {
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
  }

  while (candidates.size > 0) {
    let top = null
    let topCount = 0

    for (const [tag, count] of tagCounts) {
      if (count > topCount || (count === topCount && count > 0 && collator.compare(tag, top) < 0)) {
        top = tag
        topCount = count
      }
    }

    if (top === null || topCount < MIN_TAG_GROUP) { break }

    const group = proposal(`tag:${top}`, 'tag', top, null)

    for (const entry of [...candidates]) {
      if (!entry.tags.includes(top)) { continue }

      const shown = [top, ...entry.tags.filter(tag => tag !== top)].slice(0, 3)

      group.channels.push({ channel: entry.channel, sourceProfileId: null, evidence: { type: 'tags', tags: shown } })
      candidates.delete(entry)

      for (const tag of entry.tags) {
        tagCounts.set(tag, tagCounts.get(tag) - 1)
      }
    }
  }

  // What was dismissed goes: its pool channels back to the pool, its moves
  // for good, as the channels are still where they are
  const placed = new Set()
  const kept = []

  for (const found of byKey.values()) {
    if (dismissed.has(found.key) || found.channels.length === 0) { continue }

    for (const suggested of found.channels) {
      placed.add(suggested.channel.id)
    }

    kept.push(found)
  }

  const order = new Map(profiles.map((profile, index) => [profile._id, index]))
  const kindOrder = { profile: 0, category: 1, tag: 2 }

  kept.sort((a, b) => {
    if (a.kind !== b.kind) { return kindOrder[a.kind] - kindOrder[b.kind] }
    if (a.kind === 'profile') { return order.get(a.profileId) - order.get(b.profileId) }
    if (a.channels.length !== b.channels.length) { return b.channels.length - a.channels.length }

    return collator.compare(a.name, b.name)
  })

  for (const found of kept) {
    const sorted = sortChannels(found.channels.map(suggested => suggested.channel), collator)
    const byId = new Map(found.channels.map(suggested => [suggested.channel.id, suggested]))

    found.channels = sorted.map(channel => byId.get(channel.id))
  }

  const remainder = sortChannels(subscribed.filter(channel => !memberships.has(channel.id) && !placed.has(channel.id)), collator)

  return {
    proposals: kept,
    remainder,
    coverage: {
      known: knownCount,
      total: subscribed.length,
      profiles: characters.size,
      profileCount: profiles.length
    }
  }
}
