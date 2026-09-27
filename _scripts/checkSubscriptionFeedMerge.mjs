/**
 * Checks the rules for assembling the four subscription feeds into one stream.
 *
 * The merge is the one place where the kinds meet, and it fails quietly: a post
 * that sorts to the bottom of the stream because its time was read from the
 * wrong field looks exactly like a channel that has not posted lately, and a
 * live stream listed twice looks like the channel uploaded it twice. Nothing
 * throws. So the rules are asserted here.
 *
 * Run with `pnpm run check-subscription-feed-merge`. There is no test runner in
 * this project, which is why this is a script.
 */

import {
  mergeSubscriptionFeedEntries,
  splitUpcomingEntries,
  subscriptionEntryIsUpcoming,
  subscriptionEntryPublishedAt,
  subscriptionEntryScheduledAt
} from '../src/subscriptionFeedMerge.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_760_000_000_000

/** A video, short or live stream, as every source spells one. */
function video(id, daysAgo, overrides = {}) {
  return {
    videoId: id,
    authorId: 'UC1',
    author: 'Channel',
    title: id,
    type: 'video',
    published: NOW - daysAgo * DAY,
    ...overrides
  }
}

/** A community post, which spells its time differently and has no video id. */
function post(id, daysAgo, overrides = {}) {
  return {
    postId: id,
    authorId: 'UC1',
    author: 'Channel',
    type: 'community',
    publishedTime: NOW - daysAgo * DAY,
    ...overrides
  }
}

const idsOf = entries => entries.map(entry => entry.videoId ?? entry.postId).join(',')

// The whole point: a post takes its place among the videos by date, rather than
// arriving after them because it was a different list
{
  const merged = mergeSubscriptionFeedEntries([
    [video('v-today', 0), video('v-old', 5)],
    [post('p-yesterday', 1)]
  ])

  check(
    `posts interleave with videos by date (${idsOf(merged)})`,
    idsOf(merged) === 'v-today,p-yesterday,v-old'
  )
}

// Every kind at once, newest first, regardless of which list it came in
{
  const merged = mergeSubscriptionFeedEntries([
    [video('video', 3)],
    [video('short', 1, { type: 'shortVideo' })],
    [video('live', 4, { liveNow: true })],
    [post('post', 2)]
  ])

  check(
    `four kinds sort into one order (${idsOf(merged)})`,
    idsOf(merged) === 'short,post,video,live'
  )
}

// The sort field is read per entry, not per list: a list holding both spellings
// still sorts correctly, which is what stops the merge from depending on the
// caller having grouped things the way it expects
{
  const merged = mergeSubscriptionFeedEntries([
    [post('p-old', 9), video('v-new', 1), post('p-new', 0)]
  ])

  check(`both time fields are read within one list (${idsOf(merged)})`, idsOf(merged) === 'p-new,v-new,p-old')
}

// An entry nothing dates sorts last rather than anywhere
{
  const undated = { videoId: 'undated', type: 'video' }
  const merged = mergeSubscriptionFeedEntries([[undated, video('dated', 300)]])

  check(`an undated entry sorts last (${idsOf(merged)})`, idsOf(merged) === 'dated,undated')
  check('and an undated entry reads as zero, not NaN', subscriptionEntryPublishedAt(undated) === 0)
}

// A finished live stream reported by two feeds is one entry, and it is the one
// from the earlier list
{
  const asLive = video('dup', 2, { liveNow: false, lengthSeconds: '' })
  const asVideo = video('dup', 2, { lengthSeconds: '1:02:03' })

  const merged = mergeSubscriptionFeedEntries([[asVideo], [asLive]])

  check(`the same video from two feeds appears once (${merged.length})`, merged.length === 1)
  check('and it is the copy from the earlier list', merged[0] === asVideo)
}

// Two posts by different channels can share nothing but a null video id; that
// must not collapse them
{
  const merged = mergeSubscriptionFeedEntries([[post('p1', 1), post('p2', 2)]])

  check(`posts are not confused with each other (${idsOf(merged)})`, idsOf(merged) === 'p1,p2')
}

// Something with neither id — a shape no parser produces today, but the merge
// should not silently swallow all but one of them if one ever does
{
  const merged = mergeSubscriptionFeedEntries([[
    { type: 'video', published: NOW },
    { type: 'video', published: NOW - DAY }
  ]])

  check(`entries with no id are all kept (${merged.length})`, merged.length === 2)
}

// The entries are the cached objects, passed through. The detail back-fill
// writes into them in place, so a merge that copied would break it in a way
// nothing else would notice.
{
  const original = video('v', 1)
  const merged = mergeSubscriptionFeedEntries([[original]])

  check('entries are passed through, not copied', merged[0] === original)
}

// Assembling is not allowed to reorder the caller's lists underneath it: the
// per-kind list is what the back-fill and the per-kind filters were handed
{
  const list = [video('a', 1), video('b', 2)]
  const before = idsOf(list)

  mergeSubscriptionFeedEntries([list])

  check(`the input lists are left alone (${before} -> ${idsOf(list)})`, idsOf(list) === before)
}

// An empty stream is an empty stream, not a crash
check('no kinds at all merges to nothing', mergeSubscriptionFeedEntries([]).length === 0)
check('empty kinds merge to nothing', mergeSubscriptionFeedEntries([[], [], [], []]).length === 0)

/**
 * Something scheduled, dated the way each source dates it. `daysAhead` is
 * negative for the past, since a premiere's publish time is its premiere date.
 */
function upcoming(id, daysAhead, overrides = {}) {
  return video(id, -daysAhead, {
    isUpcoming: true,
    premiereDate: new Date(NOW + daysAhead * DAY),
    lengthSeconds: '',
    ...overrides
  })
}

// The point of the shelf: nothing that has not happened yet is in the stream,
// whatever its publish time says, and what is left is still newest first
{
  const { stream, upcoming: shelf } = splitUpcomingEntries(mergeSubscriptionFeedEntries([
    [video('yesterday', 1), video('last-week', 7)],
    [upcoming('premiere', 3)]
  ]), NOW)

  check(`the future leaves the stream (${idsOf(stream)})`, idsOf(stream) === 'yesterday,last-week')
  check(`and lands on the shelf (${idsOf(shelf)})`, idsOf(shelf) === 'premiere')
}

// The shelf is a schedule, so it runs the other way from the stream
{
  const { upcoming: shelf } = splitUpcomingEntries([
    upcoming('in-six-days', 6),
    upcoming('in-two-hours', 1 / 12),
    upcoming('tomorrow', 1)
  ], NOW)

  check(`the shelf is soonest first (${idsOf(shelf)})`, idsOf(shelf) === 'in-two-hours,tomorrow,in-six-days')
}

// Splitting must not disturb the order the merge put the stream in
{
  const merged = mergeSubscriptionFeedEntries([[video('a', 1), video('b', 2), video('c', 3)]])
  const { stream } = splitUpcomingEntries(merged, NOW)

  check(`the stream keeps the merged order (${idsOf(stream)})`, idsOf(stream) === 'a,b,c')
}

// Every source's way of saying "scheduled", including the shape that has the
// flag and nothing else
{
  const invidious = video('invidious', -2, { premiereTimestamp: (NOW + 2 * DAY) / 1000 })
  const flagOnly = video('flag-only', -2, { isUpcoming: true })
  const localFlag = video('premiere-flag', -2, { premiere: true })

  check('Invidious premieres are upcoming', subscriptionEntryIsUpcoming(invidious, NOW))
  check('a bare upcoming flag is enough', subscriptionEntryIsUpcoming(flagOnly, NOW))
  check('and so is a bare premiere flag', subscriptionEntryIsUpcoming(localFlag, NOW))
  check('an ordinary video is not upcoming', !subscriptionEntryIsUpcoming(video('ordinary', 1), NOW))
}

// The RSS guess that the hide-premieres setting falls back to is deliberately
// not used here: a new upload nobody has watched yet is not a premiere
{
  const unwatched = video('unwatched', 0, { isRSS: true, viewCount: 0 })

  check('an unwatched RSS entry stays in the stream', !subscriptionEntryIsUpcoming(unwatched, NOW))
}

// A premiere date that has been through the cache is a string, and a shelf that
// could not read it would order the whole schedule by nothing
{
  const cached = video('cached', -3, { isUpcoming: true, premiereDate: new Date(NOW + 3 * DAY).toISOString() })

  check(
    `a cached premiere date still dates the entry (${subscriptionEntryScheduledAt(cached)})`,
    subscriptionEntryScheduledAt(cached) === NOW + 3 * DAY
  )
}

// The premiere date wins over the publish time derived from it, and an entry
// with neither says so rather than claiming the epoch
{
  const disagreeing = video('disagreeing', -1, { isUpcoming: true, premiereDate: new Date(NOW + 5 * DAY) })

  check('the stated premiere date is the scheduled time', subscriptionEntryScheduledAt(disagreeing) === NOW + 5 * DAY)
  check('an undated entry has no scheduled time', subscriptionEntryScheduledAt({ videoId: 'undated' }) === null)
}

// The flag is never taken off — an RSS refresh carries the old one back — so a
// premiere that has aired is still marked upcoming for ever. It has happened,
// so it belongs in the stream, at the time it happened, which is where its
// publish time already puts it
{
  const aired = upcoming('aired-in-august', -14)
  const { stream, upcoming: shelf } = splitUpcomingEntries(
    mergeSubscriptionFeedEntries([[video('yesterday', 1), aired, video('last-month', 30)]]),
    NOW
  )

  check('an event that has passed is not upcoming', !subscriptionEntryIsUpcoming(aired, NOW))
  check(`it rejoins the stream at its own time (${idsOf(stream)})`, idsOf(stream) === 'yesterday,aired-in-august,last-month')
  check('and the shelf is left with the things still ahead', shelf.length === 0)
}

// The moment itself belongs to the past: a premiere that started a second ago
// has started
{
  const starting = upcoming('starting', 0)

  check('an event due now has begun', !subscriptionEntryIsUpcoming(starting, NOW))
  check('and one due in a minute has not', subscriptionEntryIsUpcoming(upcoming('soon', 1 / 1440), NOW))
}

// An undated upcoming entry is still upcoming; it just cannot claim a place in
// the order
{
  const undated = { videoId: 'undated', type: 'video', isUpcoming: true }
  const { upcoming: shelf } = splitUpcomingEntries([undated, upcoming('dated', 9)], NOW)

  check(`an undated event sorts last on the shelf (${idsOf(shelf)})`, idsOf(shelf) === 'dated,undated')
}

// Nothing upcoming is the ordinary case, and it must not cost the stream
// anything
{
  const entries = [video('a', 1), video('b', 2)]
  const { stream, upcoming: shelf } = splitUpcomingEntries(entries, NOW)

  check(`a stream with no future is unchanged (${idsOf(stream)})`, idsOf(stream) === 'a,b')
  check('and the shelf is empty', shelf.length === 0)
  check('splitting leaves the input list alone', idsOf(entries) === 'a,b')
}

// PeerTube entries, as the platform layer's feed hands them to the cache:
// `published` in ms, `liveNow`, `isUpcoming` and `premiereDate` (a Date) only
// when scheduled
{
  const peerTube = (id, daysAgo, overrides = {}) => video(id, daysAgo, {
    platform: 'peertube',
    host: 'video.example',
    authorId: 'channel@video.example',
    liveNow: false,
    isUpcoming: false,
    ...overrides
  })

  const youtube = [video('yt-today', 0), video('yt-old', 5)]
  const uploads = [peerTube('pt-yesterday', 1), peerTube('pt-older', 3)]
  const lives = [
    peerTube('pt-live', 0.5, { liveNow: true }),
    peerTube('pt-scheduled', 2, { isUpcoming: true, premiereDate: new Date(NOW + 2 * DAY) }),
    peerTube('pt-waiting', 4, { isUpcoming: true })
  ]

  const { stream, upcoming: shelf } = splitUpcomingEntries(mergeSubscriptionFeedEntries([youtube, uploads, lives]), NOW)

  check(
    `PeerTube uploads interleave with YouTube's by date (${idsOf(stream)})`,
    idsOf(stream) === 'yt-today,pt-live,pt-yesterday,pt-older,pt-waiting,yt-old'
  )
  check(`a scheduled PeerTube live is on the shelf (${idsOf(shelf)})`, idsOf(shelf) === 'pt-scheduled')
  check(
    'at its scheduled time',
    subscriptionEntryScheduledAt(lives[1]) === NOW + 2 * DAY
  )
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
