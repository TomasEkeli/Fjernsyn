import { describe, expect, it, vi } from 'vitest'

import {
  lemmyCommunity,
  lemmyDescription,
  lemmyFeedUrl,
  lemmyKind,
  lemmyShares,
  lemmySource,
  lemmyVotes,
  lemmyWhy,
  mergeLemmyPosts,
  parseLemmyFeed,
} from './lemmy'

// Real feeds, trimmed to a few items each: lemmy.cafe's mealtimevideos by
// New and by TopWeek, and its documentaries by TopYear, for the links that
// are not YouTube videos (a hosted .mp4, an image, an article, a torrent, a
// PeerTube /w/ link) and a /live/ link. Fetched 2026-11-01.
import mealtimeNew from './fixtures/lemmy.cafe--mealtimevideos-new.xml?raw'
import mealtimeTopWeek from './fixtures/lemmy.cafe--mealtimevideos-topweek.xml?raw'
import documentariesTopYear from './fixtures/lemmy.cafe--documentaries-topyear.xml?raw'
// lemmy.world's peertube by New, trimmed to seven items: four PeerTube links
// (/w/ with a short uuid twice, /w/ with a uuid, /videos/watch/), and a
// GitHub release, a Mastodon post and a PieFed community. Fetched 2026-11-01.
import peertubeNew from './fixtures/lemmy.world--peertube-new.xml?raw'

const NOW = Date.parse('2026-11-01T12:00:00Z')

const MEALTIME = { name: 'mealtimevideos', host: 'lemmy.cafe' }
const SOURCE_ID = 'lemmy:mealtimevideos@lemmy.cafe'

/** The header Lemmy writes at the top of every item's description */
function header(points, url = null) {
  const link = url === null ? '' : `<br><a href="${url}">${url}</a>`
  return `submitted by <a href="https://lemmy.sdf.org/u/someone">someone</a> to <a href="https://lemmy.cafe/c/mealtimevideos">mealtimevideos</a><br>${points} points | <a href="https://lemmy.cafe/post/1">2 comments</a>${link}`
}

/**
 * A post as the feed gives it, for tests that need one made up
 *
 * @param {Partial<import('./lemmy').LemmyPost>} fields
 */
function post(fields) {
  return { postUrl: 'https://lemmy.cafe/post/1', title: 'T', link: 'https://youtu.be/vSHrY5xJsxg', sharedAt: NOW, headerRead: true, votes: 1, why: null, ...fields }
}

describe('a Lemmy post\'s votes', () => {
  it('are the points Lemmy writes in the description', () => {
    expect(lemmyVotes(header(15, 'https://www.youtube.com/watch?v=neGgUavFT0w'))).toBe(15)
    expect(lemmyVotes(header(0))).toBe(0)
  })

  it('can be fewer than none', () => {
    expect(lemmyVotes(header(-3))).toBe(-3)
  })

  it('are read as one point too, should Lemmy ever write it so', () => {
    expect(lemmyVotes(header(1).replace('1 points', '1 point'))).toBe(1)
  })

  it('are the header\'s, not a number of points the post\'s body mentions', () => {
    expect(lemmyVotes(`${header(8)}<p>He scored<br>40 points | twice</p>`)).toBe(8)
  })

  it('are read with the line break written either way', () => {
    expect(lemmyVotes(header(12).replace('<br>12 points', '<br/>12 points'))).toBe(12)
  })

  it('are none when the description does not say, as when Lemmy changes its wording', () => {
    expect(lemmyVotes('submitted by someone<br>15 votes | 1 comments')).toBe(null)
    expect(lemmyVotes('')).toBe(null)
  })
})

describe('why a Lemmy post shared its video', () => {
  it('is the post\'s body, after the header and the link', () => {
    expect(lemmyWhy(`${header(15, 'https://www.youtube.com/watch?v=neGgUavFT0w')}<p>A nerdy deep dive on guardrails.</p>\n`)).toBe('A nerdy deep dive on guardrails.')
  })

  it('is nothing when the post has no body', () => {
    expect(lemmyWhy(header(4, 'https://www.youtube.com/watch?v=DYt_hPzKik0'))).toBe(null)
    expect(lemmyWhy(`${header(4, 'https://www.youtube.com/watch?v=DYt_hPzKik0')}\n<p> </p>`)).toBe(null)
  })

  it('keeps each paragraph on a line of its own, as plain text', () => {
    const body = '<blockquote>\n<p>Beneath the <em>luxury</em> lies a hidden world.</p>\n<p>High Class &amp; more.</p>\n</blockquote>\n<p>Found it <a href="https://example.org">here</a>.</p>\n'

    expect(lemmyWhy(`${header(8, 'https://www.youtube.com/live/kvEypYGj2D8?=0')}${body}`)).toBe('Beneath the luxury lies a hidden world.\nHigh Class & more.\nFound it here.')
  })

  it('is the body of a post whose link is an image, which Lemmy draws in place of the link\'s text', () => {
    const image = 'https://lemmy.world/pictrs/image/718e7c0d.jpeg'
    const description = `${header(11)}<br><a href="${image}"><img src="${image}"/></a><p>Researched by Dr McLaughlin.</p>`

    expect(lemmyWhy(description)).toBe('Researched by Dr McLaughlin.')
  })

  it('is the body of a post without a link', () => {
    expect(lemmyWhy(`${header(5)}<p>Would you like a playlist?</p>`)).toBe('Would you like a playlist?')
  })

  it('is nothing when the header cannot be found, rather than the header taken for a reason', () => {
    expect(lemmyWhy('submitted by someone<br>15 votes<p>Body</p>')).toBe(null)
  })
})

describe('a Lemmy post\'s description, read once', () => {
  it('gives its votes and its why', () => {
    expect(lemmyDescription(`${header(15, 'https://youtu.be/vSHrY5xJsxg')}<p>Why.</p>`)).toEqual({ votes: 15, why: 'Why.' })
    expect(lemmyDescription(header(4))).toEqual({ votes: 4, why: null })
  })

  it('gives nothing when its header cannot be read, which is not the same as no votes and no why', () => {
    expect(lemmyDescription('submitted by someone<br>15 votes | 1 comments<p>Body</p>')).toBe(null)
  })
})

describe('a Lemmy community\'s RSS feed', () => {
  it('gives every post in it, with its link, title, date, votes and why', () => {
    const posts = parseLemmyFeed(mealtimeNew)

    expect(posts).toHaveLength(8)
    expect(posts[0]).toEqual({
      postUrl: 'https://lemmy.cafe/post/42041782',
      headerRead: true,
      title: 'Guardrails Are Life-Saving Machines (When They Work) | Road Guy Rob and Steve the Guardrail Guy [37:06]',
      link: 'https://www.youtube.com/watch?v=neGgUavFT0w',
      sharedAt: Date.parse('2026-10-31T21:30:56Z'),
      votes: 15,
      why: 'A nerdy infrastructure engineering deep dive on guardrails, and a look on how even inexpensive common-sense measures (like “THIS SIDE UP” stickers) to ensure their non-deadly installation are still not required by law.',
    })
  })

  it('gives a post without body text no why', () => {
    const bigBen = parseLemmyFeed(mealtimeNew).find(item => item.link === 'https://www.youtube.com/watch?v=DYt_hPzKik0')

    expect(bigBen).toMatchObject({ votes: 4, why: null, title: 'What happens inside Big Ben when the time changes? [25:05]' })
  })

  it('gives a post without a link none', () => {
    const meta = parseLemmyFeed(mealtimeNew).find(item => item.title.startsWith('[meta]'))

    expect(meta.link).toBe(null)
    expect(meta.why).not.toBe(null)
  })

  it('reads the link as a link, with its entities as the characters they are', () => {
    const links = parseLemmyFeed(mealtimeNew).map(item => item.link)

    expect(links).toContain('https://www.youtube.com/watch?v=H8YdOF1yXfM&pp=ygUMc2NvdHQgY2FybmV5')
    expect(links).toContain('https://m.youtube.com/watch?v=n9lHLdAJUDE')
    expect(links).toContain('https://youtu.be/vSHrY5xJsxg')
  })

  it('says of a post whose header it cannot read so, and gives it no votes and no why', () => {
    const feed = mealtimeTopWeek.replace('15 points |', '15 votes |')

    expect(parseLemmyFeed(feed)[0]).toMatchObject({ headerRead: false, votes: null, why: null })
    expect(parseLemmyFeed(feed)[1]).toMatchObject({ headerRead: true, votes: 8 })
  })

  it('gives a post with a date it cannot read no date', () => {
    const feed = mealtimeTopWeek.replace('Sat, 31 Oct 2026 21:30:56 +0000', 'sometime')

    expect(parseLemmyFeed(feed)[0].sharedAt).toBe(null)
  })

  it('leaves out an item without a link to its post, which no share could point back to', () => {
    const feed = mealtimeTopWeek
      .replace('<link>https://lemmy.cafe/post/42041782</link>', '')
      .replace('<comments>https://lemmy.cafe/post/42041782</comments>', '')
      .replace('<guid>https://lemmy.cafe/post/42041782</guid>', '')

    expect(parseLemmyFeed(feed).map(item => item.postUrl)).toEqual(['https://lemmy.cafe/post/41934384'])
  })

  it('gives nothing for a feed with no posts', () => {
    expect(parseLemmyFeed('<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>')).toEqual([])
  })

  it('fails on what is not an RSS feed, as an instance\'s error page', () => {
    expect(() => parseLemmyFeed('<html><body><h1>503 Service Unavailable</h1></body></html>')).toThrow()
    expect(() => parseLemmyFeed('not xml at all <')).toThrow()
    expect(() => parseLemmyFeed('{"error":"couldnt_find_community"}')).toThrow()
  })
})

describe('the posts of two feeds of one community', () => {
  it('are each post once, by its link, as first given', () => {
    const merged = mergeLemmyPosts([parseLemmyFeed(mealtimeNew), parseLemmyFeed(mealtimeTopWeek)])

    expect(merged.map(item => item.postUrl)).toEqual(parseLemmyFeed(mealtimeNew).map(item => item.postUrl))
  })

  it('keep a post only the second feed has', () => {
    const merged = mergeLemmyPosts([[post({ postUrl: 'a' })], [post({ postUrl: 'a', votes: 9 }), post({ postUrl: 'b' })]])

    expect(merged.map(item => [item.postUrl, item.votes])).toEqual([['a', 1], ['b', 1]])
  })
})

describe('a Lemmy community\'s posts as shares', () => {
  it('are the posts that link a YouTube video, each with what the post says of it', () => {
    const shares = lemmyShares(parseLemmyFeed(mealtimeNew), SOURCE_ID, NOW)

    expect(shares.map(share => share.videoId)).toEqual(['neGgUavFT0w', 'dTXl4RQimbY', 'DYt_hPzKik0', 'n9lHLdAJUDE', 'H8YdOF1yXfM', 'vSHrY5xJsxg'])
    expect(shares[0]).toEqual({
      _id: 'lemmy:mealtimevideos@lemmy.cafe|neGgUavFT0w',
      sourceId: SOURCE_ID,
      videoId: 'neGgUavFT0w',
      title: 'Guardrails Are Life-Saving Machines (When They Work) | Road Guy Rob and Steve the Guardrail Guy [37:06]',
      author: '',
      votes: 15,
      why: expect.stringMatching(/^A nerdy infrastructure/),
      sharedAt: Date.parse('2026-10-31T21:30:56Z'),
      discussionUrl: 'https://lemmy.cafe/post/42041782',
      seenAt: NOW,
    })
  })

  it('skip a post without a link, and one to a PeerTube video that was not confirmed', () => {
    const videoIds = lemmyShares(parseLemmyFeed(mealtimeNew), SOURCE_ID, NOW).map(share => share.videoId)

    expect(videoIds).not.toContain('059ca8df-3049-44a3-93a9-d603327f2e74')
    expect(videoIds).toHaveLength(6)
  })

  it('make a post whose PeerTube link was confirmed a share of that video, by its uuid and origin host', () => {
    const ref = { platform: 'peertube', host: 'peertube.v1.root42.de', videoId: '059ca8df-3049-44a3-93a9-d603327f2e74' }
    const [share] = lemmyShares([post({ link: 'https://fedi.video/w/1GcddTf1uzhyXscJ4ymdEG', ref, votes: 7 })], SOURCE_ID, NOW)

    expect(share).toEqual({
      _id: `${SOURCE_ID}|059ca8df-3049-44a3-93a9-d603327f2e74@peertube.v1.root42.de`,
      sourceId: SOURCE_ID,
      videoId: '059ca8df-3049-44a3-93a9-d603327f2e74',
      platform: 'peertube',
      host: 'peertube.v1.root42.de',
      title: 'T',
      author: '',
      votes: 7,
      why: null,
      sharedAt: NOW,
      discussionUrl: 'https://lemmy.cafe/post/1',
      seenAt: NOW,
    })
  })

  it('are one share for a PeerTube video linked on two instances, as its ref is the same', () => {
    const ref = { platform: 'peertube', host: 'peertube.v1.root42.de', videoId: '059ca8df-3049-44a3-93a9-d603327f2e74' }
    const shares = lemmyShares([
      post({ postUrl: 'https://lemmy.cafe/post/1', link: 'https://fedi.video/w/1GcddTf1uzhyXscJ4ymdEG', ref, votes: 2 }),
      post({ postUrl: 'https://lemmy.cafe/post/2', link: 'https://peertube.v1.root42.de/videos/watch/059ca8df-3049-44a3-93a9-d603327f2e74', ref, votes: 9 }),
    ], SOURCE_ID, NOW)

    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ votes: 9, discussionUrl: 'https://lemmy.cafe/post/2' })
  })

  it('skip hosted clips, images, articles and torrents', () => {
    const posts = parseLemmyFeed(documentariesTopYear)

    expect(posts).toHaveLength(6)
    expect(lemmyShares(posts, 'lemmy:documentaries@lemmy.cafe', NOW).map(share => share.videoId)).toEqual(['kvEypYGj2D8'])
  })

  it('are one share for a video posted twice, the post with the most votes, the earlier on a tie', () => {
    const shares = lemmyShares([
      post({ postUrl: 'https://lemmy.cafe/post/1', votes: 3, sharedAt: 1 }),
      post({ postUrl: 'https://lemmy.cafe/post/2', votes: 30, sharedAt: 2 }),
      post({ postUrl: 'https://lemmy.cafe/post/3', votes: 30, sharedAt: 3 }),
    ], SOURCE_ID, NOW)

    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ votes: 30, discussionUrl: 'https://lemmy.cafe/post/2' })
  })

  it('leave out the votes and the why of a post whose header could not be read, so that those kept stay', () => {
    const [share] = lemmyShares([post({ headerRead: false, votes: null, why: null })], SOURCE_ID, NOW)

    expect(share).not.toHaveProperty('votes')
    expect(share).not.toHaveProperty('why')
    expect(share).toMatchObject({ videoId: 'vSHrY5xJsxg', discussionUrl: 'https://lemmy.cafe/post/1' })
  })

  it('stay with the post a kept share came from while the feed still lists it, rather than go back and forth', () => {
    const kept = { [`${SOURCE_ID}|vSHrY5xJsxg`]: { _id: `${SOURCE_ID}|vSHrY5xJsxg`, discussionUrl: 'https://lemmy.cafe/post/1', votes: 3 } }
    const posts = [
      post({ postUrl: 'https://lemmy.cafe/post/1', votes: 3, sharedAt: 1 }),
      post({ postUrl: 'https://lemmy.cafe/post/2', votes: 30, sharedAt: 2 }),
    ]

    expect(lemmyShares(posts, SOURCE_ID, NOW, kept)[0].discussionUrl).toBe('https://lemmy.cafe/post/1')
    // Once that post has left the feed, the best of those listed
    expect(lemmyShares(posts.slice(1), SOURCE_ID, NOW, kept)[0].discussionUrl).toBe('https://lemmy.cafe/post/2')
  })

  it('count a post with votes over one without', () => {
    const shares = lemmyShares([
      post({ postUrl: 'https://lemmy.cafe/post/1', votes: null, sharedAt: 1 }),
      post({ postUrl: 'https://lemmy.cafe/post/2', votes: 0, sharedAt: 2 }),
    ], SOURCE_ID, NOW)

    expect(shares[0].discussionUrl).toBe('https://lemmy.cafe/post/2')
  })
})

describe('a Lemmy community, as it is written', () => {
  it.each([
    ['https://lemmy.cafe/c/mealtimevideos', MEALTIME],
    ['https://lemmy.cafe/c/mealtimevideos/', MEALTIME],
    ['https://lemmy.cafe/c/mealtimevideos?dataType=Post&sort=Active', MEALTIME],
    ['http://Lemmy.Cafe/c/mealtimevideos', MEALTIME],
    ['lemmy.cafe/c/mealtimevideos', MEALTIME],
    [' https://lemmy.cafe/c/mealtimevideos ', MEALTIME],
    // Seen from another instance: the community is its home instance's
    ['https://lemmy.world/c/mealtimevideos@lemmy.cafe', MEALTIME],
    ['!mealtimevideos@lemmy.cafe', MEALTIME],
    ['!mealtimevideos@Lemmy.Cafe', MEALTIME],
    // Its feed, as an OPML file writes it
    ['https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=New&limit=50', MEALTIME],
    ['https://lemmy.world/c/Documentary', { name: 'Documentary', host: 'lemmy.world' }],
    ['https://programming.dev/c/talks', { name: 'talks', host: 'programming.dev' }],
    // An instance on a port of its own keeps it
    ['https://lemmy.example.org:8536/c/videos', { name: 'videos', host: 'lemmy.example.org:8536' }],
    ['!videos@lemmy.example.org:8536', { name: 'videos', host: 'lemmy.example.org:8536' }],
  ])('reads %s', (text, community) => {
    expect(lemmyCommunity(text)).toEqual(community)
  })

  it.each([
    '',
    'mealtimevideos',
    'https://lemmy.cafe/',
    'https://lemmy.cafe/c/',
    'https://lemmy.cafe/u/someone',
    'https://lemmy.cafe/post/42041782',
    'https://lemmy.cafe/c/meal time',
    'https://lemmy.cafe/c/mealtimevideos/extra',
    '!mealtimevideos@',
    '@someone@mastodon.social',
    'https://hackertube.org',
    'https://www.youtube.com/watch?v=neGgUavFT0w',
    'ftp://lemmy.cafe/c/mealtimevideos',
    'https://localhost/c/mealtimevideos',
    // YouTube's own /c/ pages are channels
    'https://www.youtube.com/c/LastWeekTonight',
    'https://youtube.com/c/LastWeekTonight',
    'https://m.youtube.com/c/LastWeekTonight',
    'https://lemmy.cafe/c/videos@youtube.com',
    '!videos@youtube.com',
    // Without the !, a handle is an email address, a Mastodon or a PeerTube account as likely
    'mealtimevideos@lemmy.cafe',
    'someone@example.org',
  ])('does not read %s', (text) => {
    expect(lemmyCommunity(text)).toBe(null)
  })

  it.each([
    // Loopback, and anything resolving there
    'https://127.0.0.1/c/videos',
    'https://127.8.9.10:8536/c/videos',
    'https://0.0.0.0/c/videos',
    'https://foo.localhost/c/videos',
    'https://localhost./c/videos',
    '!videos@127.0.0.1',
    // Written another way, still loopback
    '!videos@127.1',
    'https://2130706433/c/videos',
    'https://0x7f.0.0.1/c/videos',
    // Private
    'https://10.0.0.5/c/videos',
    'https://172.16.0.1/c/videos',
    'https://172.31.255.255/feeds/c/videos.xml?sort=New',
    'https://192.168.1.10/c/videos',
    'https://lemmy.world/c/videos@192.168.1.10',
    // Link-local
    'https://169.254.169.254/c/videos',
    // IPv6: loopback, link-local, unique-local
    'https://[::1]/c/videos',
    'https://[fe80::1]/c/videos',
    'https://[fc00::1]/c/videos',
    'https://[fd12:3456::1]/c/videos',
    'https://[::ffff:127.0.0.1]/c/videos',
  ])('refuses %s, a host on this machine or its network', (text) => {
    expect(lemmyCommunity(text)).toBe(null)
  })

  it.each([
    ['https://172.15.0.1/c/videos', '172.15.0.1'],
    ['https://172.32.0.1/c/videos', '172.32.0.1'],
    ['https://8.8.8.8/c/videos', '8.8.8.8'],
    ['https://lemmy.localhost.example/c/videos', 'lemmy.localhost.example'],
  ])('reads %s, a public host', (text, host) => {
    expect(lemmyCommunity(text)).toEqual({ name: 'videos', host })
  })
})

describe('a Lemmy community as a source', () => {
  it('is known by its name and home instance, and links to its page there', () => {
    expect(lemmySource(MEALTIME, NOW)).toEqual({
      _id: SOURCE_ID,
      kind: 'lemmy',
      url: 'https://lemmy.cafe/c/mealtimevideos',
      name: 'mealtimevideos@lemmy.cafe',
      followedAt: NOW,
    })
  })

  it('is the same source whatever the case of its name', () => {
    expect(lemmySource({ name: 'Documentary', host: 'lemmy.world' }, NOW)._id).toBe('lemmy:documentary@lemmy.world')
  })

  it('has its feed at its home instance, by the sort asked, fifty at a time', () => {
    expect(lemmyFeedUrl(MEALTIME, 'TopWeek')).toBe('https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=TopWeek&limit=50')
    expect(lemmyFeedUrl({ name: 'videos', host: 'lemmy.example.org:8536' }, 'New')).toBe('https://lemmy.example.org:8536/feeds/c/videos.xml?sort=New&limit=50')
  })

  it('keeps the name as written in its link and feed, which Lemmy looks up in any case, and lower-cases it only in its id', () => {
    expect(lemmySource({ name: 'Documentary', host: 'lemmy.world' }, NOW)).toMatchObject({ url: 'https://lemmy.world/c/Documentary', name: 'Documentary@lemmy.world' })
  })
})

/**
 * lemmy.cafe as the refresh asks it: each feed URL answered by the function
 * given for its sort
 *
 * @param {Record<string, () => Response>} [bySort]
 */
function fakeLemmy(bySort = {}) {
  const sorts = {
    New: () => new Response(mealtimeNew, { headers: { 'content-type': 'application/rss+xml' } }),
    TopWeek: () => new Response(mealtimeTopWeek, { headers: { 'content-type': 'application/rss+xml' } }),
    ...bySort,
  }

  return vi.fn(async (url) => {
    const { origin, pathname, searchParams } = new URL(url)
    const sort = searchParams.get('sort')

    if (origin !== 'https://lemmy.cafe' || pathname !== '/feeds/c/mealtimevideos.xml' || !Object.hasOwn(sorts, sort)) {
      return new Response('not found', { status: 404 })
    }

    return sorts[sort]()
  })
}

describe('Lemmy as a source kind', () => {
  const source = lemmySource(MEALTIME, NOW)

  it('is the kind lemmy', () => {
    expect(lemmyKind.kind).toBe('lemmy')
  })

  it('recognises a community, in any of the forms it is written, as its source', () => {
    expect(lemmyKind.recognise('!mealtimevideos@lemmy.cafe', NOW)).toEqual(source)
    expect(lemmyKind.recognise('https://lemmy.world/c/mealtimevideos@lemmy.cafe', NOW)).toEqual(source)
    expect(lemmyKind.recognise('https://hackertube.org', NOW)).toBe(null)
  })

  it('asks the community\'s home instance for its newest posts and its week\'s top, fifty each, with a time limit', async () => {
    const fetch = fakeLemmy()

    await lemmyKind.fetch(source, { fetch })

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=New&limit=50',
      'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=TopWeek&limit=50',
    ])
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('gives the posts of both, each once', async () => {
    const { items } = await lemmyKind.fetch(source, { fetch: fakeLemmy() })

    expect(items.map(item => item.postUrl)).toEqual(parseLemmyFeed(mealtimeNew).map(item => item.postUrl))
  })

  it('gives a post only the week\'s top still has, as one shared before the newest fifty', async () => {
    const older = mealtimeTopWeek.replaceAll('41934384', '10000001')
    const { items } = await lemmyKind.fetch(source, { fetch: fakeLemmy({ TopWeek: () => new Response(older) }) })

    expect(items.map(item => item.postUrl)).toContain('https://lemmy.cafe/post/10000001')
  })

  it('fails when the instance serves no feed, as slrpnk.net does, or answers with an error', async () => {
    await expect(lemmyKind.fetch(source, { fetch: fakeLemmy({ New: () => new Response('not found', { status: 404 }) }) })).rejects.toThrow('404')
    await expect(lemmyKind.fetch(source, { fetch: fakeLemmy({ TopWeek: () => new Response('down', { status: 503 }) }) })).rejects.toThrow('503')
  })

  it('fails when no post in a feed has a header it can read, as when Lemmy changes its wording, so that the votes and whys kept are not taken for none', async () => {
    const reworded = mealtimeNew.replaceAll(/(\d+) points \|/g, '$1 votes |')

    await expect(lemmyKind.fetch(source, { fetch: fakeLemmy({ New: () => new Response(reworded) }) })).rejects.toThrow('header')
  })

  it('does not fail on a feed with no posts, which has no header to read', async () => {
    const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>'

    const { items } = await lemmyKind.fetch(source, { fetch: fakeLemmy({ New: () => new Response(empty) }) })

    expect(items).toHaveLength(2)
  })

  it('fails when the instance answers with something that is not a feed', async () => {
    await expect(lemmyKind.fetch(source, { fetch: fakeLemmy({ New: () => new Response('<html><h1>503</h1></html>') }) })).rejects.toThrow()
  })

  it('fails when the instance cannot be reached', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })

    await expect(lemmyKind.fetch(source, { fetch })).rejects.toThrow('Failed to fetch')
  })

  it('fails for a source whose URL is not a community', async () => {
    await expect(lemmyKind.fetch({ ...source, url: 'https://lemmy.cafe/' }, { fetch: fakeLemmy() })).rejects.toThrow()
  })

  describe('with PeerTube links', () => {
    const PEERTUBE = { name: 'peertube', host: 'lemmy.world' }
    const peertubeSource = lemmySource(PEERTUBE, NOW)
    const feeds = () => vi.fn(async (url) => {
      return new URL(url).pathname === '/feeds/c/peertube.xml'
        ? new Response(peertubeNew)
        : new Response('not found', { status: 404 })
    })
    // As the platform layer would confirm them: blender's and tilvids'
    // videos are PeerTube's, at their origins; peertube.wtf is not
    // PeerTube, and gianmarco's could not be asked
    const confirmed = {
      '309d37bf-2674-474d-a1e4-1eb05e6d9073': { platform: 'peertube', host: 'video.blender.org', videoId: '309d37bf-2674-474d-a1e4-1eb05e6d9073' },
      'ef67ed68-de61-4c06-a9c0-90d1569bc9bf': { platform: 'peertube', host: 'origin.example', videoId: 'ef67ed68-de61-4c06-a9c0-90d1569bc9bf' },
    }
    const peertube = () => ({ refFor: vi.fn(async candidate => confirmed[candidate.videoId] ?? null) })

    it('asks the platform layer about each link of PeerTube\'s shapes, and about nothing else', async () => {
      const resolver = peertube()

      await lemmyKind.fetch(peertubeSource, { fetch: feeds(), peertube: resolver })

      expect(resolver.refFor.mock.calls.map(([candidate]) => candidate).sort((a, b) => a.host.localeCompare(b.host))).toEqual([
        { host: 'peertube.wtf', videoId: expect.stringMatching(/^[\da-f-]{36}$/) },
        { host: 'tilvids.com', videoId: 'ef67ed68-de61-4c06-a9c0-90d1569bc9bf' },
        { host: 'video.blender.org', videoId: '309d37bf-2674-474d-a1e4-1eb05e6d9073' },
        { host: 'videos.gianmarco.gg', videoId: expect.stringMatching(/^[\da-f-]{36}$/) },
      ])
    })

    it('makes the confirmed ones shares, at their origins, and skips the rest', async () => {
      const { items } = await lemmyKind.fetch(peertubeSource, { fetch: feeds(), peertube: peertube() })

      const shares = lemmyKind.toShares(items, peertubeSource, NOW, {})

      expect(shares.map(share => share._id).sort()).toEqual([
        'lemmy:peertube@lemmy.world|309d37bf-2674-474d-a1e4-1eb05e6d9073@video.blender.org',
        'lemmy:peertube@lemmy.world|ef67ed68-de61-4c06-a9c0-90d1569bc9bf@origin.example',
      ])
      expect(shares.every(share => share.platform === 'peertube')).toBe(true)
    })

    it('asks about no more than three links at a time', async () => {
      let asking = 0
      let most = 0
      const slow = {
        refFor: vi.fn(async () => {
          most = Math.max(most, ++asking)
          await new Promise(resolve => setTimeout(resolve, 1))
          asking--
          return null
        }),
      }

      await lemmyKind.fetch(peertubeSource, { fetch: feeds(), peertube: slow })

      expect(slow.refFor).toHaveBeenCalledTimes(4)
      expect(most).toBeLessThanOrEqual(3)
    })

    it('takes no link for PeerTube without the layer to ask, and still gives every post', async () => {
      const { items } = await lemmyKind.fetch(peertubeSource, { fetch: feeds() })

      expect(items).toHaveLength(7)
      expect(lemmyKind.toShares(items, peertubeSource, NOW, {})).toEqual([])
    })
  })

  it('makes its posts the source\'s shares', () => {
    const shares = lemmyKind.toShares(parseLemmyFeed(mealtimeNew), source, NOW, {})

    expect(shares).toHaveLength(6)
    expect(shares.every(share => share.sourceId === SOURCE_ID && share.seenAt === NOW)).toBe(true)
  })
})
