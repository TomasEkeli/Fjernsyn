import { describe, expect, it } from 'vitest'

import { failure, fakeToDash, INSTANCE, localInstance, localWith, setUp } from './testing/videoLayer'

import invidiousLive from './fixtures/invidious--video-live.json'
import invidiousOrdinary from './fixtures/invidious--video-ordinary.json'
import invidiousPostLiveDvr from './fixtures/invidious--video-post-live-dvr.json'
import invidiousShort from './fixtures/invidious--video-short.json'
import invidiousUpcoming from './fixtures/invidious--video-upcoming.json'
import localLive from './fixtures/local--video-live.json'
import localOrdinary from './fixtures/local--video-ordinary.json'
import localPostLiveDvr from './fixtures/local--video-post-live-dvr.json'
import localShort from './fixtures/local--video-short.json'
import localUpcoming from './fixtures/local--video-upcoming.json'

// The playback source is `./playback.test.js`'s; these are the details

const YOUTUBE = {
  type: 'video',
  descriptionKind: 'html',
  language: null,
  commentsEnabled: null,
  downloadEnabled: false,
  downloadOptions: [],
  // None of the fixtures has a chat: those are below
  liveChat: null,
  // Nor an AI label: those are below too
  aiVerdict: null,
}

const next = videoId => ({ type: 'video', videoId, title: `Next ${videoId}` })
const channel = (id, name, thumbnail, subscriberCount) => ({ id, name, thumbnail, subscriberCount })

const RICK = 'UCuAXFkgsw1L7xaCfnd5JJOw'
const RICK_AVATAR = 'https://yt3.ggpht.com/_ShEGOdg-t5YGJse14Ooq6FYBZqX_QSlhaTNjG06miYusm5lWm1UroLyVxnYtahADfRTVLtuVQ=s176-c-k-c0x00ffffff-no-rj'
const PIXELFIRE = 'UCYk-yy4tkrWpvYu_iM6fjtA'
const PIXELFIRE_AVATAR = 'https://yt3.ggpht.com/6bGHuUouoR3BnftOWmwxJ_8nko8e7C8MIvuvSCKMctZOQ46jSfXkD0srNM3GkghXg_yjCtIjTQ=s176-c-k-c0x00ffffff-no-rj'
const ABC = 'UCBi2mrWuNuyYy4gbM6fU18Q'
const ABC_AVATAR = 'https://yt3.ggpht.com/GJ8V0NX6NddGh9bf4zED4tsjPjjBK2hdp5FWHMy09pV7sdSkkE3yEhCRSch4waEb9ZavyUrWfw=s176-c-k-c0x00ffffff-no-rj'
const LOFI = 'UCSJ4gkVC6NrvII8umztf0Ow'
const LOFI_AVATAR = 'https://yt3.ggpht.com/GyVPysrx-cVIWIQDfi2MkaYr7oRIxuOgGeZihnw-hgTv6E5LBQ67v5yXTFvqP2Bl7BB_S-0L-A=s176-c-k-c0x00ffffff-no-rj'
const PREMIERE_CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa'

const LOCAL_CASES = [
  ['an ordinary video', localOrdinary, {
    videoId: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
    author: 'Rick Astley',
    authorId: RICK,
    thumbnail: 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp',
    lengthSeconds: 213,
    published: Date.parse('2009-10-24T23:57:33-07:00'),
    viewCount: 1822420518,
    liveNow: false,
    isUpcoming: false,
    description: 'The official video for “Never Gonna Give You Up” by Rick Astley. \n<a href="https://www.youtube.com/hashtag/rickastleynever">#RickAstleyNever</a><b> &lt;3</b>',
    likeCount: 19455015,
    dislikeCount: null,
    tags: ['rick astley', 'Never Gonna Give You Up', 'nggyu'],
    category: 'Music',
    licence: 'Creative Commons Attribution licence (reuse allowed)',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    channel: channel(RICK, 'Rick Astley', RICK_AVATAR, 4550000),
    authorThumbnail: RICK_AVATAR,
    liveStatus: null,
    chaptersKind: 'chapters',
    isFamilyFriendly: true,
    isUnlisted: false,
    // Lockups of videos and stations, compact videos and movies; not
    // playlists, and not an item the parser cannot read
    related: [next('pCJ9JGG0GQI'), next('RDdQw4w9WgX'), next('TMpUsykbezI'), next('xr1fSpQadVk')],
  }],
  ['a short, which the details cannot tell from a video', localShort, {
    videoId: '4hDEK_1wPBk',
    title: 'How To Learn Blender',
    author: 'PixelFire',
    authorId: PIXELFIRE,
    thumbnail: 'https://i.ytimg.com/vi/4hDEK_1wPBk/maxres2.jpg',
    lengthSeconds: 60,
    published: Date.parse('2024-06-27T11:58:26-07:00'),
    viewCount: 701853,
    liveNow: false,
    isUpcoming: false,
    description: '<a href="https://www.youtube.com/hashtag/pixelfire">#PixelFire</a>',
    likeCount: 36013,
    dislikeCount: null,
    tags: [],
    category: 'Entertainment',
    licence: null,
    url: 'https://www.youtube.com/watch?v=4hDEK_1wPBk',
    channel: channel(PIXELFIRE, 'PixelFire', PIXELFIRE_AVATAR, 16000),
    authorThumbnail: PIXELFIRE_AVATAR,
    liveStatus: null,
    chaptersKind: 'chapters',
    isFamilyFriendly: true,
    isUnlisted: false,
    related: [next('z-Xl9tGqH14')],
  }],
  ['a live, with no length and no legacy formats', localLive, {
    videoId: 'ODio2-1aFa8',
    title: 'LIVE: ABC News Live - Friday, October 2',
    author: 'ABC News',
    authorId: ABC,
    thumbnail: 'https://i.ytimg.com/vi/ODio2-1aFa8/maxresdefault.jpg?v=6abbf952',
    published: Date.parse('2026-09-29T10:45:54-07:00'),
    viewCount: 41105,
    liveNow: true,
    isUpcoming: false,
    description: 'Subscribe to ABC News on YouTube',
    likeCount: 193,
    dislikeCount: null,
    tags: ['news', 'breaking news'],
    category: 'News & Politics',
    licence: null,
    url: 'https://www.youtube.com/watch?v=ODio2-1aFa8',
    channel: channel(ABC, 'ABC News', ABC_AVATAR, 19800000),
    authorThumbnail: ABC_AVATAR,
    liveStatus: 'live',
    chaptersKind: 'chapters',
    isFamilyFriendly: true,
    isUnlisted: false,
    related: [next('z4Nph7EoRd4')],
  }],
  ['an upcoming premiere, with its date and nothing to play', localUpcoming, {
    videoId: 'UpCmNgPrm01',
    title: 'The premiere',
    author: 'A channel',
    authorId: PREMIERE_CHANNEL,
    thumbnail: 'https://i.ytimg.com/vi/UpCmNgPrm01/hqdefault.jpg',
    lengthSeconds: 0,
    published: Date.parse('2026-10-01T09:00:00-07:00'),
    viewCount: 0,
    liveNow: false,
    isUpcoming: true,
    premiereDate: new Date('2026-10-05T18:00:00.000Z'),
    // No text runs: the short description, escaped
    description: 'Coming soon &amp; then some',
    likeCount: null,
    dislikeCount: null,
    tags: [],
    category: 'Film & Animation',
    licence: null,
    url: 'https://www.youtube.com/watch?v=UpCmNgPrm01',
    channel: channel(PREMIERE_CHANNEL, 'A channel', 'https://yt3.ggpht.com/a-channel=s176', 1234),
    authorThumbnail: 'https://yt3.ggpht.com/a-channel=s176',
    liveStatus: 'waiting',
    chaptersKind: 'chapters',
    isFamilyFriendly: false,
    isUnlisted: true,
    related: [],
  }],
  ['a post-live DVR, with no legacy formats', localPostLiveDvr, {
    videoId: 'jfKfPfyJRdk',
    title: 'lofi hip hop radio 📚 beats to relax/study to',
    author: 'Lofi Girl',
    authorId: LOFI,
    thumbnail: 'https://i.ytimg.com/vi/jfKfPfyJRdk/maxresdefault.jpg?v=6911ace0',
    lengthSeconds: 121601512,
    published: Date.parse('2022-07-12T05:12:29-07:00'),
    viewCount: 651847107,
    liveNow: false,
    isUpcoming: false,
    description: '🎼 | Listen on Spotify, Apple music and more',
    likeCount: 3487767,
    dislikeCount: null,
    tags: ['lofi'],
    category: 'Music',
    licence: null,
    url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
    channel: channel(LOFI, 'Lofi Girl', LOFI_AVATAR, 15800000),
    authorThumbnail: LOFI_AVATAR,
    liveStatus: 'ended',
    chaptersKind: 'chapters',
    isFamilyFriendly: true,
    isUnlisted: false,
    related: [next('fqFpp-sjZ00')],
  }],
]

const onInstance = name => `${INSTANCE}/ggpht/${name}=s48`

const INVIDIOUS_CASES = [
  ['an ordinary video', invidiousOrdinary, {
    videoId: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
    author: 'Rick Astley',
    authorId: RICK,
    thumbnail: `${INSTANCE}/vi/dQw4w9WgXcQ/maxres.jpg`,
    lengthSeconds: 213,
    published: 1256453853000,
    viewCount: 1822420518,
    liveNow: false,
    isUpcoming: false,
    description: 'The official video.\n<a href="https://linktr.ee/rickastleynever">https://linktr.ee/rickastleynever</a> <a href="https://www.youtube.com/hashtag/rickastleynever">#RickAstleyNever</a>',
    likeCount: 19455015,
    dislikeCount: 0,
    tags: ['rick astley', 'Never Gonna Give You Up'],
    category: 'Music',
    licence: null,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    channel: channel(RICK, 'Rick Astley', onInstance('rick'), 4550000),
    authorThumbnail: onInstance('rick'),
    liveStatus: null,
    chaptersKind: 'chapters',
    isFamilyFriendly: true,
    isUnlisted: false,
    // The ISO date of a recommendation made ms, as the old view does
    related: [
      { type: 'video', videoId: 'pCJ9JGG0GQI', title: 'Recommended', author: 'Someone', authorId: 'UCbbbbbbbbbbbbbbbbbbbbbb', lengthSeconds: 240, viewCount: 1000, viewCountText: '1K', published: Date.parse('2024-01-02T03:04:05Z') },
      { type: 'video', videoId: 'TMpUsykbezI', title: 'Another', author: 'Someone', authorId: 'UCbbbbbbbbbbbbbbbbbbbbbb', lengthSeconds: 100, viewCount: 10 },
    ],
  }],
  ['a short, which the details cannot tell from a video', invidiousShort, {
    videoId: '4hDEK_1wPBk',
    title: 'How To Learn Blender',
    author: 'PixelFire',
    authorId: PIXELFIRE,
    thumbnail: `${INSTANCE}/vi/4hDEK_1wPBk/maxres.jpg`,
    lengthSeconds: 60,
    published: 1719514706000,
    viewCount: 701853,
    liveNow: false,
    isUpcoming: false,
    description: '<a href="https://www.youtube.com/hashtag/pixelfire">#PixelFire</a>',
    likeCount: 36013,
    dislikeCount: 0,
    tags: [],
    category: 'Entertainment',
    licence: null,
    url: 'https://www.youtube.com/watch?v=4hDEK_1wPBk',
    channel: channel(PIXELFIRE, 'PixelFire', onInstance('pixelfire'), 16000),
    authorThumbnail: onInstance('pixelfire'),
    liveStatus: null,
    chaptersKind: 'chapters',
    isFamilyFriendly: true,
    isUnlisted: false,
    related: [],
  }],
  ['a live, with no length and no legacy formats', invidiousLive, {
    videoId: 'ODio2-1aFa8',
    title: 'LIVE: ABC News Live - Friday, October 2',
    author: 'ABC News',
    authorId: ABC,
    thumbnail: `${INSTANCE}/vi/ODio2-1aFa8/maxres.jpg`,
    published: 1759168954000,
    viewCount: 41105,
    liveNow: true,
    isUpcoming: false,
    description: 'Subscribe',
    likeCount: 193,
    dislikeCount: 0,
    tags: ['news'],
    category: 'News & Politics',
    licence: null,
    url: 'https://www.youtube.com/watch?v=ODio2-1aFa8',
    channel: channel(ABC, 'ABC News', onInstance('abc'), 19800000),
    authorThumbnail: onInstance('abc'),
    liveStatus: 'live',
    chaptersKind: 'chapters',
    isFamilyFriendly: true,
    isUnlisted: false,
    related: [],
  }],
  ['an upcoming premiere, with its date and nothing to play', invidiousUpcoming, {
    videoId: 'UpCmNgPrm01',
    title: 'The premiere',
    author: 'A channel',
    authorId: PREMIERE_CHANNEL,
    thumbnail: `${INSTANCE}/vi/UpCmNgPrm01/maxres.jpg`,
    lengthSeconds: 0,
    published: 1759334400000,
    viewCount: 0,
    liveNow: false,
    isUpcoming: true,
    premiereDate: new Date(1759687200 * 1000),
    // `descriptionHtml` of empty elements: the plain description, escaped
    description: 'Coming soon &amp; then some',
    likeCount: 0,
    dislikeCount: 0,
    tags: [],
    category: 'Film & Animation',
    licence: null,
    url: 'https://www.youtube.com/watch?v=UpCmNgPrm01',
    channel: channel(PREMIERE_CHANNEL, 'A channel', onInstance('a-channel'), 1230),
    authorThumbnail: onInstance('a-channel'),
    liveStatus: 'waiting',
    chaptersKind: 'chapters',
    isFamilyFriendly: false,
    isUnlisted: true,
    related: [],
  }],
  ['a post-live DVR, with no legacy formats', invidiousPostLiveDvr, {
    videoId: 'jfKfPfyJRdk',
    title: 'lofi hip hop radio 📚 beats to relax/study to',
    author: 'Lofi Girl',
    authorId: LOFI,
    thumbnail: `${INSTANCE}/vi/jfKfPfyJRdk/maxres.jpg`,
    lengthSeconds: 121601512,
    published: 1657627949000,
    viewCount: 651847107,
    liveNow: false,
    isUpcoming: false,
    description: 'Listen',
    likeCount: 3487767,
    dislikeCount: 0,
    tags: ['lofi'],
    category: 'Music',
    licence: null,
    url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
    channel: channel(LOFI, 'Lofi Girl', onInstance('lofi'), 15800000),
    authorThumbnail: onInstance('lofi'),
    liveStatus: 'ended',
    chaptersKind: 'chapters',
    isFamilyFriendly: true,
    isUnlisted: false,
    related: [],
  }],
]

describe('a YouTube video\'s details from Local', () => {
  it.each(LOCAL_CASES)('reads %s', async (_what, fixture, expected) => {
    const { layer, fake } = setUp({ answers: { getLocalVideoInfo: localInstance(fixture) } })

    const { playbackSource: _source, ...details } = await layer.getVideo(expected.videoId)

    expect(details).toEqual({ ...YOUTUBE, ...expected })
    expect(fake.callsOf('getLocalVideoInfo')).toEqual([[expected.videoId]])
    expect(fake.callsOf('invidiousGetVideoInformation')).toEqual([])
  })

  it('falls back to the short description, escaped, when the text runs do not parse', async () => {
    const { layer, fake } = setUp({ answers: { getLocalVideoInfo: localInstance(localWith(localOrdinary, (info) => { info.basic_info.short_description = 'Tom & <Jerry>' })) } })
    fake.respond('parseLocalTextRuns', () => { throw new Error('not an array of text runs') })

    expect((await layer.getVideo('dQw4w9WgXcQ')).description).toBe('Tom &amp; &lt;Jerry&gt;')
  })

  it('reads the title, published date and view count from the page where the player response lacks them', async () => {
    const { layer } = setUp({
      answers: {
        getLocalVideoInfo: localInstance(localWith(localOrdinary, (info) => {
          info.primary_info.title.text = '  The localised title '
          delete info.page[0].microformat.publish_date
          delete info.basic_info.view_count
        })),
      },
    })

    const video = await layer.getVideo('dQw4w9WgXcQ')

    expect(video.title).toBe('The localised title')
    expect(video.published).toBe(Date.parse('Oct 25, 2009'))
    expect(video.viewCount).toBe(1822420518)
  })
})

describe('a YouTube video\'s details from Invidious', () => {
  it.each(INVIDIOUS_CASES)('reads %s', async (_what, fixture, expected) => {
    const { layer, fake } = setUp({ answers: { invidiousGetVideoInformation: fixture }, config: { backendPreference: 'invidious' } })

    const { playbackSource: _source, ...details } = await layer.getVideo(expected.videoId)

    expect(details).toEqual({ ...YOUTUBE, ...expected })
    expect(fake.callsOf('invidiousGetVideoInformation')).toEqual([[expected.videoId]])
    expect(fake.callsOf('getLocalVideoInfo')).toEqual([])
  })

  it('cleans YouTube\'s redirect out of a relative link, as the old description does', async () => {
    const video = structuredClone(invidiousOrdinary)
    video.answer.descriptionHtml = '<a href="/redirect?event=video_description&amp;q=https%3A%2F%2Fexample.org%2F" target="_blank">example.org</a>'
    const { layer } = setUp({ answers: { invidiousGetVideoInformation: video }, config: { backendPreference: 'invidious' } })

    expect((await layer.getVideo('dQw4w9WgXcQ')).description).toBe('<a href="https://example.org/" >example.org</a>')
  })
})

describe('a YouTube video\'s live chat', () => {
  /** A Local answer with a chat, whose `getLiveChat` answers the given handle */
  function withChat(fixture, handle) {
    const chatted = localWith(fixture, (info) => { info.livechat = { type: 'LiveChat', continuation: 'chat-continuation', is_replay: false } })
    return localInstance(chatted, info => ({ toDash: fakeToDash(info), getLiveChat: () => handle }))
  }

  it.each([
    ['a live', localLive, 'ODio2-1aFa8'],
    ['an upcoming video', localUpcoming, 'UpCmNgPrm01'],
  ])('is a handle on %s from Local, the very one the library answered', async (_what, fixture, id) => {
    const handle = { chat: id }
    const { layer } = setUp({ answers: { getLocalVideoInfo: withChat(fixture, handle) } })

    expect((await layer.getVideo(id)).liveChat).toBe(handle)
  })

  it('is none for a video that is neither live nor upcoming, even with a chat (a replay)', async () => {
    const { layer } = setUp({ answers: { getLocalVideoInfo: withChat(localOrdinary, { chat: 'replay' }) } })

    expect((await layer.getVideo('dQw4w9WgXcQ')).liveChat).toBeNull()
  })

  it('is none for a live from Invidious', async () => {
    const { layer } = setUp({ answers: { invidiousGetVideoInformation: invidiousLive }, config: { backendPreference: 'invidious' } })

    const video = await layer.getVideo('ODio2-1aFa8')

    expect(video.liveStatus).toBe('live')
    expect(video.liveChat).toBeNull()
  })
})

describe('a YouTube video\'s AI label', () => {
  /** @param {'ai' | 'not-ai'} aiVerdict */
  function labelled(aiVerdict) {
    const copy = structuredClone(localOrdinary)
    copy.answer.aiVerdict = aiVerdict
    return localInstance(copy)
  }

  it.each(['ai', 'not-ai'])('is the verdict Local read from the /next it had anyway: %s', async (verdict) => {
    const { fake, layer } = setUp({ answers: { getLocalVideoInfo: labelled(verdict) } })

    expect((await layer.getVideo('dQw4w9WgXcQ')).aiVerdict).toBe(verdict)
    expect(fake.callsOf('getLocalVideoInfo')).toHaveLength(1)
  })

  it('is none from Invidious, which does not carry the label', async () => {
    const { layer } = setUp({ answers: { invidiousGetVideoInformation: invidiousOrdinary }, config: { backendPreference: 'invidious' } })

    expect((await layer.getVideo('dQw4w9WgXcQ')).aiVerdict).toBeNull()
  })
})

describe('a YouTube video\'s thumbnail by the preference', () => {
  it.each([
    ['start', 'maxres1'],
    ['middle', 'maxres2'],
    ['end', 'maxres3'],
  ])('takes the %s frame, on i.ytimg.com from Local and on the instance from Invidious', async (thumbnailPreference, frame) => {
    const local = setUp({ answers: { getLocalVideoInfo: localInstance(localOrdinary) }, config: { thumbnailPreference } })
    const invidious = setUp({ answers: { invidiousGetVideoInformation: invidiousOrdinary }, config: { thumbnailPreference, backendPreference: 'invidious' } })

    expect((await local.layer.getVideo('dQw4w9WgXcQ')).thumbnail).toBe(`https://i.ytimg.com/vi/dQw4w9WgXcQ/${frame}.jpg`)
    expect((await invidious.layer.getVideo('dQw4w9WgXcQ')).thumbnail).toBe(`${INSTANCE}/vi/dQw4w9WgXcQ/${frame}.jpg`)
  })
})

/** A Local answer refused for one reason, from the ordinary video */
function refusedLocally(playability, more = {}) {
  return localWith(localOrdinary, (info) => {
    info.playability_status = playability
    Object.assign(info, more)
  })
}

describe('a YouTube video refused', () => {
  it.each([
    ['private', refusedLocally({ status: 'LOGIN_REQUIRED', reason: 'This video is private', error_screen: { reason: { text: 'Private video' } } })],
    ['membersOnly', refusedLocally({ status: 'UNPLAYABLE', reason: 'Join this channel to get access to members-only content', error_screen: { offer_id: 'sponsors_only_video' } })],
    ['ageRestricted', refusedLocally({ status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' })],
    ['ageRestricted', localInstance(refusedLocally({ status: 'UNPLAYABLE', reason: 'Video unavailable' }, { has_trailer: true }), () => ({ getTrailerInfo: () => null }))],
    ['drm', refusedLocally({ status: 'OK' }, { streaming_data: { formats: [], adaptive_formats: [{ drm_families: ['WIDEVINE'] }] } })],
  ])('by Local as %s, final with fallback on', async (reason, getLocalVideoInfo) => {
    const { layer, fake } = setUp({ answers: { getLocalVideoInfo }, config: { backendFallback: true } })

    const error = await failure(layer.getVideo('dQw4w9WgXcQ'))

    expect([error.kind, error.reason]).toEqual(['refused', reason])
    expect(fake.callsOf('invidiousGetVideoInformation')).toEqual([])
  })

  // These may be about the address asking rather than the video, and an
  // Invidious instance asks YouTube from its own (ADR-0019)
  it.each([
    ['ipBlock', refusedLocally({ status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' })],
    ['unexplained', refusedLocally({ status: 'UNPLAYABLE', reason: 'Video unavailable' })],
    ['no reason', refusedLocally({
      status: 'UNPLAYABLE',
      reason: 'Video unavailable',
      error_screen: { subreason: { text: 'The uploader has not made this video available in your country' } },
    })],
  ])('by Local as %s, answered by Invidious with fallback on', async (_reason, getLocalVideoInfo) => {
    const { layer, fake } = setUp({
      answers: { getLocalVideoInfo, invidiousGetVideoInformation: invidiousOrdinary },
      config: { backendFallback: true },
    })

    const video = await layer.getVideo('dQw4w9WgXcQ')

    expect(video.thumbnail).toBe(`${INSTANCE}/vi/dQw4w9WgXcQ/maxres.jpg`)
    expect(fake.callsOf('getLocalVideoInfo')).toHaveLength(1)
    expect(fake.callsOf('invidiousGetVideoInformation')).toHaveLength(1)
  })

  it.each([
    ['private', 'This video is private'],
    ['membersOnly', 'Join this channel to get access to members-only content like this video, and other exclusive perks.'],
    ['ageRestricted', 'Sign in to confirm your age'],
    ['drm', 'This video is DRM protected'],
  ])('by Invidious as %s, final with fallback on', async (reason, message) => {
    const { layer, fake } = setUp({
      answers: { invidiousGetVideoInformation: new Error(message) },
      config: { backendPreference: 'invidious', backendFallback: true },
    })

    const error = await failure(layer.getVideo('dQw4w9WgXcQ'))

    expect([error.kind, error.reason]).toEqual(['refused', reason])
    expect(fake.callsOf('getLocalVideoInfo')).toEqual([])
  })

  // Invidious' messages name no unexplained or reasonless refusal: its bare
  // "Video unavailable" is not found (below), which is tried on Local too.
  // The policy's own tests cover those two from Invidious.
  it('by Invidious as ipBlock, answered by Local with fallback on', async () => {
    const { layer, fake } = setUp({
      answers: { invidiousGetVideoInformation: new Error('Sign in to confirm you’re not a bot'), getLocalVideoInfo: localInstance(localOrdinary) },
      config: { backendPreference: 'invidious', backendFallback: true },
    })

    const video = await layer.getVideo('dQw4w9WgXcQ')

    expect(video.thumbnail).toBe('https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp')
    expect(fake.callsOf('invidiousGetVideoInformation')).toHaveLength(1)
    expect(fake.callsOf('getLocalVideoInfo')).toHaveLength(1)
  })
})

/** What youtubei.js throws for a removed video: an `InnertubeError` carrying the playability */
const removed = () => Object.assign(new Error('This video is unavailable'), {
  info: { status: 'ERROR', reason: 'This video has been removed by the uploader' },
})

describe('a YouTube video that is not found', () => {
  it('is tried once on Invidious when Local, preferred, has no such video', async () => {
    const { layer, fake } = setUp({
      answers: { getLocalVideoInfo: removed(), invidiousGetVideoInformation: invidiousOrdinary },
      config: { backendFallback: true },
    })

    const video = await layer.getVideo('dQw4w9WgXcQ')

    expect(video.thumbnail).toBe(`${INSTANCE}/vi/dQw4w9WgXcQ/maxres.jpg`)
    expect(fake.calls.filter(call => /Video/.test(call.name)).map(call => call.name)).toEqual(['getLocalVideoInfo', 'invidiousGetVideoInformation'])
  })

  it('is tried once on Local when Invidious, preferred, has no such video, and fails as not found when neither has it', async () => {
    const { layer, fake } = setUp({
      answers: { invidiousGetVideoInformation: new Error('This video has been removed by the uploader'), getLocalVideoInfo: removed() },
      config: { backendPreference: 'invidious', backendFallback: true },
    })

    expect((await failure(layer.getVideo('dQw4w9WgXcQ'))).kind).toBe('notFound')
    expect(fake.callsOf('invidiousGetVideoInformation')).toHaveLength(1)
    expect(fake.callsOf('getLocalVideoInfo')).toHaveLength(1)
  })

  it('reads an ERROR playability as not found too, and goes nowhere else with fallback off', async () => {
    const { layer, fake } = setUp({ answers: { getLocalVideoInfo: refusedLocally({ status: 'ERROR', reason: 'Video unavailable' }) } })

    expect((await failure(layer.getVideo('dQw4w9WgXcQ'))).kind).toBe('notFound')
    expect(fake.callsOf('invidiousGetVideoInformation')).toEqual([])
  })
})
