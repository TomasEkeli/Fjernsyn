/**
 * Merging details fetched from a channel into cached subscription videos.
 *
 * RSS feeds carry a title, an author, an exact publish time, an exact view
 * count and nothing else. In particular they carry no duration, which is why
 * the feed shows no duration badge when it was built from RSS. The channel
 * pages carry duration and the live and premiere flags, so the two can be
 * combined: keep what RSS does better, take what only the channel page has.
 *
 * This lives outside both the store and the datastore because both need it and
 * they must not disagree. The equivalent logic for shorts is written out twice,
 * once in each, which is a standing invitation for the two to drift apart.
 */

/**
 * Fields the channel page has and RSS does not. Only filled in when the cached
 * entry has nothing, so that a later refresh cannot undo them.
 */
const DETAIL_FIELDS = [
  'liveNow',
  'isUpcoming',
  'premiereDate',
  'is4k',
  'is8k',
  'isVr180',
  'isVr360',
  'is3d',
  'hasCaptions',
  'isNew',
  'premium',
  'description'
]

/**
 * A duration of `'0:00'` is what the RSS parser writes when it has none, and
 * `''` is what the scrapers write for a live stream. Both mean "not known".
 * @param {unknown} lengthSeconds
 */
export function durationIsMissing(lengthSeconds) {
  return lengthSeconds === '0:00' || lengthSeconds === '' || lengthSeconds == null
}

/**
 * Carry details already learned about a video into a newly fetched copy of it.
 *
 * A refresh replaces a channel's videos outright, and an RSS entry has no
 * duration, so a refresh threw away everything the back-fill had gone and
 * fetched. The videos were then found to be missing their durations again and
 * fetched again, every single refresh, for videos that had not changed at all.
 *
 * The incoming copy stays authoritative for everything it actually knows: the
 * title, the publish time, the view count. Only what it cannot know is carried
 * over.
 *
 * @param {any[] | null | undefined} previousVideos
 * @param {any[] | null} incomingVideos mutated in place
 * @returns {any[] | null} the incoming videos, for convenience
 */
export function carryOverKnownVideoDetails(previousVideos, incomingVideos) {
  if (!Array.isArray(incomingVideos) || incomingVideos.length === 0) { return incomingVideos }
  if (!Array.isArray(previousVideos) || previousVideos.length === 0) { return incomingVideos }

  const byVideoId = new Map()

  for (const video of previousVideos) {
    if (video?.videoId != null) {
      byVideoId.set(video.videoId, video)
    }
  }

  for (const incoming of incomingVideos) {
    // A PeerTube entry comes from the channel's own list, which carries the
    // duration and the live and scheduled flags, so it is complete as it is.
    // Carrying a flag over would be wrong rather than idle: a scheduled live
    // that has started loses its schedule, and handing that back would keep it
    // counted as an upcoming premiere. (Spelled out rather than imported, so
    // that this module stays import-free for the datastore.)
    if (incoming?.platform === 'peertube') { continue }

    const previous = byVideoId.get(incoming.videoId)

    if (previous == null) { continue }

    if (durationIsMissing(incoming.lengthSeconds) && !durationIsMissing(previous.lengthSeconds)) {
      incoming.lengthSeconds = previous.lengthSeconds
    }

    for (const field of DETAIL_FIELDS) {
      if (incoming[field] == null && previous[field]) {
        incoming[field] = previous[field]
      }
    }

    if (incoming.isRSS && !durationIsMissing(incoming.lengthSeconds)) {
      delete incoming.isRSS
    }

    // Kept so the item is not given a new key and rebuilt for a change that
    // nobody can see
    if (previous.lastUpdatedAt != null) {
      incoming.lastUpdatedAt = previous.lastUpdatedAt
    }
  }

  return incomingVideos
}

/**
 * @param {any[]} cachedVideos mutated in place
 * @param {any[]} channelVideos
 * @returns {boolean} whether anything changed, so callers can skip a pointless write
 */
export function mergeChannelPageVideoDetails(cachedVideos, channelVideos) {
  if (!Array.isArray(cachedVideos) || cachedVideos.length === 0) { return false }
  if (!Array.isArray(channelVideos) || channelVideos.length === 0) { return false }

  const byVideoId = new Map()

  for (const video of channelVideos) {
    if (video?.videoId != null) {
      byVideoId.set(video.videoId, video)
    }
  }

  let changed = false

  for (const cached of cachedVideos) {
    const fresh = byVideoId.get(cached.videoId)

    if (fresh == null) { continue }

    let entryChanged = false

    if (durationIsMissing(cached.lengthSeconds) && !durationIsMissing(fresh.lengthSeconds)) {
      cached.lengthSeconds = fresh.lengthSeconds
      entryChanged = true
    }

    // Titles get edited, so the newer one wins
    if (fresh.title != null && fresh.title !== cached.title) {
      cached.title = fresh.title
      entryChanged = true
    }

    if (fresh.author != null && fresh.author !== cached.author) {
      cached.author = fresh.author
      entryChanged = true
    }

    // RSS reports an exact view count while the channel page rounds it, so the
    // larger number is the better one: 12345 beats 12000, 15000 beats 12345.
    if (typeof fresh.viewCount === 'number' && !(fresh.viewCount <= cached.viewCount)) {
      cached.viewCount = fresh.viewCount
      entryChanged = true
    }

    // `published` is deliberately never touched. RSS has an exact timestamp,
    // whereas the local scraper derives one from text like "3 days ago". Taking
    // the scraper's would reorder the feed under whoever is reading it, since
    // the feed is sorted by this field.

    for (const field of DETAIL_FIELDS) {
      // Deliberately truthiness rather than a null check. These are flags and
      // an absent one already reads as false everywhere, so writing an explicit
      // false would mean a database write and a re-render for a video that has
      // not actually changed. None of these fields is meaningfully false, empty
      // or zero.
      if (cached[field] == null && fresh[field]) {
        cached[field] = fresh[field]
        entryChanged = true
      }
    }

    if (entryChanged) {
      // Now that a real duration is present, the premiere filter can use
      // `premiereDate` instead of the view count guess it falls back to for RSS
      // entries.
      if (cached.isRSS && !durationIsMissing(cached.lengthSeconds)) {
        delete cached.isRSS
      }

      // FtListVideo reads its props once, at setup, so an item has to be given a
      // new key for the change to reach the screen. FtElementList builds its key
      // partly from this field.
      cached.lastUpdatedAt = Date.now()

      changed = true
    }
  }

  return changed
}
