import { describe, expect, it, vi } from 'vitest'

import {
  lemmyCommunity,
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
  return { postUrl: 'https://lemmy.cafe/post/1', title: 'T', link: 'https://youtu.be/vSHrY5xJsxg', sharedAt: NOW, votes: 1, why: null, ...fields }
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

describe('a Lemmy community\'s RSS feed', () => {
  it('gives every post in it, with its link, title, date, votes and why', () => {
    const posts = parseLemmyFeed(mealtimeNew)

    expect(posts).toHaveLength(8)
    expect(posts[0]).toEqual({
      postUrl: 'https://lemmy.cafe/post/42041782',
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

  it('skip a post without a link, and one to a PeerTube video, until PeerTube links are recognised', () => {
    const videoIds = lemmyShares(parseLemmyFeed(mealtimeNew), SOURCE_ID, NOW).map(share => share.videoId)

    expect(videoIds).not.toContain('059ca8df-3049-44a3-93a9-d603327f2e74')
    expect(videoIds).toHaveLength(6)
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
    ['mealtimevideos@lemmy.cafe', MEALTIME],
    // Its feed, as an OPML file writes it
    ['https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=New&limit=50', MEALTIME],
    ['https://lemmy.world/c/Documentary', { name: 'Documentary', host: 'lemmy.world' }],
    ['https://programming.dev/c/talks', { name: 'talks', host: 'programming.dev' }],
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
  ])('does not read %s', (text) => {
    expect(lemmyCommunity(text)).toBe(null)
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

  it('makes its posts the source\'s shares', () => {
    const shares = lemmyKind.toShares(parseLemmyFeed(mealtimeNew), source, NOW)

    expect(shares).toHaveLength(6)
    expect(shares.every(share => share.sourceId === SOURCE_ID && share.seenAt === NOW)).toBe(true)
  })
})
