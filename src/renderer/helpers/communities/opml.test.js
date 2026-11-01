import { describe, expect, it } from 'vitest'

import { hackerTubeSource } from './hackertube'
import { lemmyCommunity, lemmySource } from './kinds/lemmy'
import { recogniseSource } from './kinds/index'
import { opmlFeedUrls, sourcesOpml } from './opml'

const NOW = Date.parse('2026-11-01T12:00:00Z')

const HACKERTUBE = hackerTubeSource(NOW)
const MEALTIME = lemmySource(lemmyCommunity('https://lemmy.cafe/c/MealtimeVideos'), NOW)
const TALKS = lemmySource(lemmyCommunity('!talks@programming.dev'), NOW)

/** @param {string} text */
function parse(text) {
  return new DOMParser().parseFromString(text, 'application/xml')
}

describe('writing the followed sources as OPML', () => {
  it('writes well-formed OPML 2.0, one feed outline per source, under the body', () => {
    const xml = parse(sourcesOpml([HACKERTUBE, MEALTIME]))

    expect(xml.querySelector('parsererror')).toBeNull()
    expect(xml.documentElement.nodeName).toBe('opml')
    expect(xml.documentElement.getAttribute('version')).toBe('2.0')
    expect(xml.querySelector('head > title')?.textContent).not.toBe('')

    const outlines = [...xml.querySelectorAll('body > outline')]
    expect(outlines).toHaveLength(2)
    for (const outline of outlines) {
      expect(outline.getAttribute('type')).toBe('rss')
    }
  })

  it('writes HackerTube as its export URL, and a Lemmy community as its feed on its home instance', () => {
    const outlines = [...parse(sourcesOpml([HACKERTUBE, MEALTIME])).querySelectorAll('outline')]
    const attributes = outlines.map(outline => ({
      text: outline.getAttribute('text'),
      title: outline.getAttribute('title'),
      xmlUrl: outline.getAttribute('xmlUrl'),
      htmlUrl: outline.getAttribute('htmlUrl'),
    }))

    expect(attributes).toEqual([
      { text: 'HackerTube', title: 'HackerTube', xmlUrl: 'https://hackertube.org/api/export', htmlUrl: 'https://hackertube.org' },
      {
        text: 'MealtimeVideos@lemmy.cafe',
        title: 'MealtimeVideos@lemmy.cafe',
        xmlUrl: 'https://lemmy.cafe/feeds/c/MealtimeVideos.xml?sort=New&limit=50',
        htmlUrl: 'https://lemmy.cafe/c/MealtimeVideos',
      },
    ])
  })

  it('escapes what XML would otherwise read as markup', () => {
    const odd = { _id: 'x', kind: 'unknown', url: 'https://example.org/?a=1&b="2"', name: 'Tom & <Jerry> \'s' }

    const outline = parse(sourcesOpml([odd])).querySelector('outline')

    expect(outline.getAttribute('text')).toBe('Tom & <Jerry> \'s')
    // A kind with no feed of its own is written as its address
    expect(outline.getAttribute('xmlUrl')).toBe('https://example.org/?a=1&b="2"')
  })

  it('writes an empty body when nothing is followed', () => {
    const xml = parse(sourcesOpml([]))

    expect(xml.querySelector('parsererror')).toBeNull()
    expect(xml.querySelectorAll('outline')).toHaveLength(0)
  })

  it('round-trips: every source written is recognised from its feed URL as the same source', () => {
    const urls = opmlFeedUrls(sourcesOpml([HACKERTUBE, MEALTIME, TALKS]))

    expect(urls.map(url => recogniseSource(url, NOW)?._id)).toEqual([HACKERTUBE._id, MEALTIME._id, TALKS._id])
    // The name keeps its case, as written
    expect(recogniseSource(urls[1], NOW)).toEqual(MEALTIME)
  })
})

describe('reading the feeds of an OPML file', () => {
  it('reads every outline with a feed URL, nested in folders or not, in document order', () => {
    const text = `<?xml version="1.0"?>
      <opml version="1.0">
        <head><title>Feeds</title></head>
        <body>
          <outline text="Video">
            <outline type="rss" text="a" xmlUrl="https://lemmy.cafe/feeds/c/a.xml?sort=New&amp;limit=50"/>
            <outline text="no feed" htmlUrl="https://example.org"/>
          </outline>
          <outline type="rss" text="b" xmlUrl="  https://hackertube.org/api/export  "/>
          <outline type="rss" text="empty" xmlUrl=""/>
        </body>
      </opml>`

    expect(opmlFeedUrls(text)).toEqual([
      'https://lemmy.cafe/feeds/c/a.xml?sort=New&limit=50',
      'https://hackertube.org/api/export',
    ])
  })

  it('reads the YouTube subscriptions export of Data settings, whose feeds no kind follows', () => {
    const text = '<opml version="1.1"><body><outline text="YouTube Subscriptions" title="YouTube Subscriptions">' +
      '<outline text="C" title="C" type="rss" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UC1"/>' +
      '</outline></body></opml>'

    const urls = opmlFeedUrls(text)

    expect(urls).toEqual(['https://www.youtube.com/feeds/videos.xml?channel_id=UC1'])
    expect(recogniseSource(urls[0], NOW)).toBeNull()
  })

  it('finds no feed in an OPML file with none', () => {
    expect(opmlFeedUrls('<opml version="2.0"><head/><body/></opml>')).toEqual([])
  })

  it('throws on a file that is not XML, or not OPML', () => {
    expect(() => opmlFeedUrls('not xml at all <')).toThrow()
    expect(() => opmlFeedUrls('<rss version="2.0"><channel/></rss>')).toThrow()
  })
})
