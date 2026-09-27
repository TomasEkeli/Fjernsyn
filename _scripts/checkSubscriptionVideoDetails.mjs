/**
 * Checks the rules for merging channel page details into cached RSS videos.
 *
 * These rules are easy to get subtly wrong in ways that are hard to see: taking
 * the wrong publish time reorders the feed under the reader, taking the wrong
 * view count makes the number go backwards, overwriting a duration that is
 * already known loses information. So they are asserted here.
 *
 * Run with `pnpm run check-subscription-video-details`.
 */

import {
  carryOverKnownVideoDetails,
  durationIsMissing,
  mergeChannelPageVideoDetails
} from '../src/subscriptionVideoDetails.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

/** What the RSS parser produces. */
function rssVideo(overrides = {}) {
  return {
    authorId: 'UC1',
    author: 'Channel',
    videoId: 'vid1',
    title: 'RSS title',
    published: 1_700_000_000_000,
    viewCount: 12345,
    type: 'video',
    lengthSeconds: '0:00',
    isRSS: true,
    ...overrides
  }
}

/** What the local scraper produces for the same video. */
function scrapedVideo(overrides = {}) {
  return {
    videoId: 'vid1',
    title: 'RSS title',
    author: 'Channel',
    authorId: 'UC1',
    // derived from text like "3 days ago", so much less precise than RSS
    published: 1_699_000_000_000,
    lengthSeconds: 754,
    viewCount: 12000,
    liveNow: false,
    isUpcoming: false,
    ...overrides
  }
}

// durationIsMissing covers both sentinels plus absence
{
  const missing = durationIsMissing

  check('0:00 counts as missing', missing('0:00'))
  check('empty string counts as missing', missing(''))
  check('undefined counts as missing', missing(undefined))
  check('null counts as missing', missing(null))
  check('a real duration is not missing', !missing(754))
  check('zero is not treated as missing', !missing(0))
}

// The headline case: a duration arrives
{
  const cached = [rssVideo()]
  const changed = mergeChannelPageVideoDetails(cached, [scrapedVideo()])

  check('reports that it changed something', changed)
  check(`duration filled in (${cached[0].lengthSeconds})`, cached[0].lengthSeconds === 754)
  check('isRSS cleared once a duration is known', cached[0].isRSS === undefined)
  check('lastUpdatedAt set so the item re-renders', typeof cached[0].lastUpdatedAt === 'number')
}

// The trap: published must survive, or the feed reorders while being read
{
  const cached = [rssVideo()]
  mergeChannelPageVideoDetails(cached, [scrapedVideo()])

  check('exact RSS publish time is kept', cached[0].published === 1_700_000_000_000)
}

// View counts: RSS is exact, the channel page rounds, so the larger wins
{
  const rounded = [rssVideo({ viewCount: 12345 })]
  mergeChannelPageVideoDetails(rounded, [scrapedVideo({ viewCount: 12000 })])
  check('rounded channel count does not overwrite the exact one', rounded[0].viewCount === 12345)

  const grown = [rssVideo({ viewCount: 12345 })]
  mergeChannelPageVideoDetails(grown, [scrapedVideo({ viewCount: 15000 })])
  check('a genuinely larger count is taken', grown[0].viewCount === 15000)
}

// A duration already known must not be replaced
{
  const cached = [rssVideo({ lengthSeconds: 999, isRSS: undefined })]
  mergeChannelPageVideoDetails(cached, [scrapedVideo({ lengthSeconds: 754 })])

  check('a known duration is left alone', cached[0].lengthSeconds === 999)
}

// Live streams have no duration and that is not a gap to fill
{
  const cached = [rssVideo()]
  mergeChannelPageVideoDetails(cached, [scrapedVideo({ lengthSeconds: '', liveNow: true })])

  check('an empty scraped duration does not overwrite', durationIsMissing(cached[0].lengthSeconds))
  check('liveNow is picked up', cached[0].liveNow === true)
  check('isRSS kept while the duration is still unknown', cached[0].isRSS === true)
}

// Titles are editable, so the newer one wins
{
  const cached = [rssVideo({ title: 'old' })]
  mergeChannelPageVideoDetails(cached, [scrapedVideo({ title: 'renamed' })])

  check('a changed title is taken', cached[0].title === 'renamed')
}

// Nothing to do means no write
{
  const cached = [rssVideo({ lengthSeconds: 754, isRSS: undefined, viewCount: 99999 })]
  const changed = mergeChannelPageVideoDetails(cached, [scrapedVideo({ viewCount: 1 })])

  check('reports no change when there is nothing to add', changed === false)
  check('leaves lastUpdatedAt alone when nothing changed', cached[0].lastUpdatedAt === undefined)
}

// Videos the channel page does not mention are untouched
{
  const cached = [rssVideo({ videoId: 'kept' }), rssVideo({ videoId: 'vid1' })]
  mergeChannelPageVideoDetails(cached, [scrapedVideo()])

  check('unmatched entries keep their placeholder duration', cached[0].lengthSeconds === '0:00')
  check('unmatched entries are not marked updated', cached[0].lastUpdatedAt === undefined)
  check('matched entries still merge', cached[1].lengthSeconds === 754)
}

// Degenerate inputs must not throw
{
  const merge = mergeChannelPageVideoDetails

  check('empty cache is a no-op', merge([], [scrapedVideo()]) === false)
  check('empty incoming is a no-op', merge([rssVideo()], []) === false)
  check('null cache is a no-op', merge(null, [scrapedVideo()]) === false)
  check('null incoming is a no-op', merge([rssVideo()], null) === false)
  check('entries without a videoId are skipped', merge([rssVideo()], [{ lengthSeconds: 5 }]) === false)
}

// Merging twice must be stable, since a channel can be offered again
{
  const cached = [rssVideo()]
  mergeChannelPageVideoDetails(cached, [scrapedVideo()])
  const firstStamp = cached[0].lastUpdatedAt
  const changedAgain = mergeChannelPageVideoDetails(cached, [scrapedVideo()])

  check('a second identical merge changes nothing', changedAgain === false)
  check('a second merge does not churn the key', cached[0].lastUpdatedAt === firstStamp)
}

// A refresh must not discard what the back-fill already learned, or every
// refresh sends the whole feed off to be fetched again
{
  const enriched = [rssVideo({ lengthSeconds: 754, isRSS: undefined, lastUpdatedAt: 1234 })]
  const refreshed = [rssVideo({ title: 'edited since', viewCount: 99999 })]

  carryOverKnownVideoDetails(enriched, refreshed)

  check('a known duration survives a refresh', refreshed[0].lengthSeconds === 754)
  check('isRSS is cleared again on the new copy', refreshed[0].isRSS === undefined)
  check('the key is not churned for an invisible change', refreshed[0].lastUpdatedAt === 1234)
  check('the refreshed title still wins', refreshed[0].title === 'edited since')
  check('the refreshed view count still wins', refreshed[0].viewCount === 99999)
}

// Flags learned from the channel page survive too
{
  const enriched = [rssVideo({ lengthSeconds: '', liveNow: true, isRSS: undefined })]
  const refreshed = [rssVideo()]

  carryOverKnownVideoDetails(enriched, refreshed)

  check('a live flag survives a refresh', refreshed[0].liveNow === true)
  check('a still-unknown duration stays unknown', durationIsMissing(refreshed[0].lengthSeconds))
  check('isRSS is kept while the duration is unknown', refreshed[0].isRSS === true)
}

// Videos that were not there before, and degenerate inputs
{
  const carry = carryOverKnownVideoDetails
  const brandNew = [rssVideo({ videoId: 'fresh' })]

  carry([rssVideo({ lengthSeconds: 754 })], brandNew)

  check('a video not seen before is left alone', durationIsMissing(brandNew[0].lengthSeconds))
  check('no previous videos is a no-op', carry(null, [rssVideo()])[0].lengthSeconds === '0:00')
  check('null incoming passes through', carry([rssVideo()], null) === null)
  check('empty incoming passes through', carry([rssVideo()], []).length === 0)
}

// A PeerTube entry is taken as fetched: its list carries the duration and the
// live and scheduled flags, so a flag the last copy had and this one lacks has
// ended, not been left out
{
  const peerTube = (overrides = {}) => ({
    platform: 'peertube',
    host: 'video.example',
    authorId: 'channel@video.example',
    author: 'Channel',
    videoId: '221b3d31-e0c2-45cb-a757-4c57a9a23df4',
    title: 'A live',
    published: 1_700_000_000_000,
    viewCount: 7,
    type: 'video',
    liveNow: false,
    isUpcoming: false,
    ...overrides
  })

  const scheduled = [peerTube({ isUpcoming: true, premiereDate: new Date(1_800_000_000_000) })]
  const onNow = [peerTube({ liveNow: true })]

  carryOverKnownVideoDetails(scheduled, onNow)

  check('a PeerTube live on now does not inherit the schedule it had', !('premiereDate' in onNow[0]))
  check('nor the upcoming flag', onNow[0].isUpcoming === false)

  const before = [peerTube({ lengthSeconds: 600, description: 'old' })]
  const after = [peerTube({ lengthSeconds: 0 })]

  carryOverKnownVideoDetails(before, after)

  check('a PeerTube entry keeps its own duration', after[0].lengthSeconds === 0)
  check('and gains nothing from the last copy', !('description' in after[0]))
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
