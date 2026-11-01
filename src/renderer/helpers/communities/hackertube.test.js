import { describe, expect, it } from 'vitest'

import {
  HACKERTUBE_SOURCE_ID,
  hackerTubeShare,
  hackerTubeSource,
  stripHackerTubeExport,
  stripHackerTubeTaxonomy,
  stripHackerTubeVideo,
} from './hackertube'

// One row of HackerTube's videos.jsonl as published (2026-10-31), every field
// it carries, most of which the bundle leaves behind
const ROW = Object.freeze({
  vid: 'fNk_zzaMoSs',
  url: 'https://www.youtube.com/watch?v=fNk_zzaMoSs',
  title: 'Vectors | Chapter 1, Essence of linear algebra',
  channel: '3Blue1Brown',
  summary: 'The first chapter of the series.',
  why_hn: 'HN\'s go-to recommendation for learning linear algebra intuition.',
  content_type: 'course',
  level: 'intro',
  shelf_life: 'evergreen',
  primary_topic: 'linear algebra',
  tags: ['vectors', 'linear algebra'],
  categories: [
    { id: 'pure-mathematics', name: 'Pure mathematics', area: 'math-theory', area_name: 'Mathematics & Theoretical CS' },
    { id: 'recreational-math', name: 'Recreational & visual math', area: 'math-theory', area_name: 'Mathematics & Theoretical CS' },
  ],
  quote: { text: 'the most welcoming introduction', hn_comment_id: 18679785, year: '2018' },
  hn: {
    mentions: 20,
    recommenders: 17,
    rec_months: 18,
    strong_recs: 14,
    stances: { rec: 5, strong_rec: 14, reference: 1 },
    first_year: 2018,
    last_year: 2026,
  },
  score: 25.0,
})

const STRIPPED = Object.freeze({
  vid: 'fNk_zzaMoSs',
  title: 'Vectors | Chapter 1, Essence of linear algebra',
  channel: '3Blue1Brown',
  why_hn: 'HN\'s go-to recommendation for learning linear algebra intuition.',
  categories: ['pure-mathematics', 'recreational-math'],
  score: 25,
  hn: { recommenders: 17, first_year: 2018, last_year: 2026 },
  quote: { hn_comment_id: 18679785 },
})

const SEEN_AT = Date.parse('2026-11-01T12:00:00Z')

describe('stripping a HackerTube video', () => {
  it('keeps the fields the app uses, and nothing else', () => {
    expect(stripHackerTubeVideo(ROW)).toEqual(STRIPPED)
  })

  it('gives the categories as their ids', () => {
    expect(stripHackerTubeVideo(ROW).categories).toEqual(['pure-mathematics', 'recreational-math'])
  })

  it('gives a video quoted from no comment a null quote', () => {
    expect(stripHackerTubeVideo({ ...ROW, quote: null }).quote).toBeNull()
    expect(stripHackerTubeVideo({ ...ROW, quote: { text: 'x' } }).quote).toBeNull()
  })

  it('gives what is missing or the wrong type as null, or an empty list', () => {
    const stripped = stripHackerTubeVideo({ vid: 'fNk_zzaMoSs' })

    expect(stripped).toEqual({
      vid: 'fNk_zzaMoSs',
      title: '',
      channel: '',
      why_hn: null,
      categories: [],
      score: null,
      hn: { recommenders: null, first_year: null, last_year: null },
      quote: null,
    })
  })

  it('drops categories without an id', () => {
    expect(stripHackerTubeVideo({ ...ROW, categories: [{ name: 'x' }, { id: 'ai-ml' }, null] }).categories).toEqual(['ai-ml'])
  })

  it('refuses a row whose video id is not a YouTube one', () => {
    expect(stripHackerTubeVideo({ ...ROW, vid: 'short' })).toBeNull()
    expect(stripHackerTubeVideo({ ...ROW, vid: undefined })).toBeNull()
    expect(stripHackerTubeVideo({ ...ROW, vid: 'fNk_zzaMoS!' })).toBeNull()
    expect(stripHackerTubeVideo(null)).toBeNull()
  })

  it('is stable: stripping a stripped video changes nothing', () => {
    expect(stripHackerTubeVideo(STRIPPED)).toEqual(STRIPPED)
  })
})

describe('stripping the taxonomy', () => {
  const TAXONOMY = {
    version: '405edcef',
    areas: [
      {
        id: 'software',
        name: 'Software Engineering & Languages',
        categories: [
          { id: 'programming-language-design', name: 'Programming language design', description: 'Long words.' },
          { id: 'web-development', name: 'Web development', description: 'More words.' },
        ],
      },
    ],
  }

  it('keeps the areas and the categories in them, by id and name, without descriptions', () => {
    expect(stripHackerTubeTaxonomy(TAXONOMY)).toEqual({
      version: '405edcef',
      areas: [
        {
          id: 'software',
          name: 'Software Engineering & Languages',
          categories: [
            { id: 'programming-language-design', name: 'Programming language design' },
            { id: 'web-development', name: 'Web development' },
          ],
        },
      ],
    })
  })

  it('gives an unreadable taxonomy as an empty one', () => {
    expect(stripHackerTubeTaxonomy(null)).toEqual({ version: null, areas: [] })
    expect(stripHackerTubeTaxonomy({ areas: 'no' })).toEqual({ version: null, areas: [] })
  })
})

describe('stripping an export', () => {
  const videosText = [
    JSON.stringify(ROW),
    '',
    '{ not json',
    JSON.stringify({ ...ROW, vid: 'bad' }),
    JSON.stringify({ ...ROW, vid: 'aaaaaaaaaaa', score: 3.5 }),
    JSON.stringify({ ...ROW, score: 1 }),
  ].join('\n')

  it('strips every readable row, skips the rest, and keeps the first of a video seen twice', () => {
    const bundle = stripHackerTubeExport({ generated: '2026-10-31', videosText, taxonomy: { version: 'v', areas: [] } })

    expect(bundle).toEqual({
      formatVersion: 1,
      generated: '2026-10-31',
      taxonomy: { version: 'v', areas: [] },
      videos: [STRIPPED, { ...STRIPPED, vid: 'aaaaaaaaaaa', score: 3.5 }],
    })
  })

  it('reads Windows line ends', () => {
    const bundle = stripHackerTubeExport({ generated: '2026-10-31', videosText: `${JSON.stringify(ROW)}\r\n`, taxonomy: null })

    expect(bundle.videos).toEqual([STRIPPED])
  })
})

describe('a HackerTube video as a share', () => {
  it('is HackerTube\'s share of the YouTube video, with its score as votes and HN\'s reason as why', () => {
    expect(hackerTubeShare(STRIPPED, SEEN_AT)).toEqual({
      _id: 'hackertube|fNk_zzaMoSs',
      sourceId: HACKERTUBE_SOURCE_ID,
      videoId: 'fNk_zzaMoSs',
      title: 'Vectors | Chapter 1, Essence of linear algebra',
      author: '3Blue1Brown',
      votes: 25,
      why: 'HN\'s go-to recommendation for learning linear algebra intuition.',
      sharedAt: Date.UTC(2026, 0, 1),
      discussionUrl: 'https://news.ycombinator.com/item?id=18679785',
      categories: ['pure-mathematics', 'recreational-math'],
      seenAt: SEEN_AT,
    })
  })

  it('is dated the first of January of the last year HN talked about it', () => {
    const share = hackerTubeShare({ ...STRIPPED, hn: { ...STRIPPED.hn, last_year: 2011 } }, SEEN_AT)

    expect(new Date(share.sharedAt).toISOString()).toBe('2011-01-01T00:00:00.000Z')
  })

  it('has no discussion link, date or votes when HackerTube gives none', () => {
    const share = hackerTubeShare({ ...STRIPPED, quote: null, score: null, hn: { recommenders: 0, first_year: null, last_year: null } }, SEEN_AT)

    expect(share.discussionUrl).toBeNull()
    expect(share.sharedAt).toBeNull()
    expect(share.votes).toBeNull()
  })

  it('keeps a score of nothing as zero votes, not as none', () => {
    expect(hackerTubeShare({ ...STRIPPED, score: 0 }, SEEN_AT).votes).toBe(0)
  })

  it('has no why when HackerTube gives an empty one', () => {
    expect(hackerTubeShare({ ...STRIPPED, why_hn: '' }, SEEN_AT).why).toBeNull()
  })

  it('is made from a raw row as well as a stripped one', () => {
    expect(hackerTubeShare(ROW, SEEN_AT)).toEqual(hackerTubeShare(STRIPPED, SEEN_AT))
  })

  it('is nothing for a row that is not a YouTube video', () => {
    expect(hackerTubeShare({ ...STRIPPED, vid: 'nope' }, SEEN_AT)).toBeNull()
  })
})

describe('the HackerTube source', () => {
  it('is followed as kind hackertube, under its one id', () => {
    expect(hackerTubeSource(SEEN_AT)).toEqual({
      _id: 'hackertube',
      kind: 'hackertube',
      url: 'https://hackertube.org',
      name: 'HackerTube',
      followedAt: SEEN_AT,
      dataGenerated: null,
    })
  })
})
