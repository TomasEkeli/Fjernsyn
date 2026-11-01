import { describe, expect, it } from 'vitest'

import { COMMUNITIES_CRAWL_DELAY_MS, COMMUNITIES_CRAWL_LIMIT, crawlDelayFrom, crawlLimitFrom, DEVELOPMENT_CRAWL_LIMIT } from './crawlLimit'

describe('the crawl\'s development limit', () => {
  it('is the number set, in a development build', () => {
    expect(crawlLimitFrom('30', 'development')).toBe(30)
    expect(crawlLimitFrom('0', 'development')).toBe(0)
  })

  it('is a small default when nothing is set, so a development run never crawls in full by accident', () => {
    expect(DEVELOPMENT_CRAWL_LIMIT).toBe(30)
    expect(crawlLimitFrom('', 'development')).toBe(30)
    expect(crawlLimitFrom(undefined, 'development')).toBe(30)
  })

  it('is lifted only when asked for in so many words', () => {
    expect(crawlLimitFrom('none', 'development')).toBeNull()
    expect(crawlLimitFrom('None', 'development')).toBe(0)
  })

  it('is no limit in any other build, whatever is set', () => {
    expect(crawlLimitFrom('30', 'production')).toBeNull()
    expect(crawlLimitFrom('30', 'test')).toBeNull()
    expect(crawlLimitFrom('30', undefined)).toBeNull()
  })

  it('allows no requests at all when what is set cannot be read, rather than every one', () => {
    expect(crawlLimitFrom('thirty', 'development')).toBe(0)
    expect(crawlLimitFrom('-5', 'development')).toBe(0)
    expect(crawlLimitFrom('2.5', 'development')).toBe(0)
    expect(crawlLimitFrom(' ', 'development')).toBe(0)
  })

  it('is none under test, which is no development build', () => {
    expect(COMMUNITIES_CRAWL_LIMIT).toBeNull()
  })
})

describe('the crawl\'s development delay', () => {
  it('is the whole number of milliseconds set, in a development build', () => {
    expect(crawlDelayFrom('2000', 'development')).toBe(2000)
  })

  it('is none when unset, or set to what cannot be read, or nought', () => {
    expect(crawlDelayFrom(undefined, 'development')).toBeNull()
    expect(crawlDelayFrom('', 'development')).toBeNull()
    expect(crawlDelayFrom('two', 'development')).toBeNull()
    expect(crawlDelayFrom('-5', 'development')).toBeNull()
    expect(crawlDelayFrom('2.5', 'development')).toBeNull()
    expect(crawlDelayFrom('0', 'development')).toBeNull()
  })

  it('is none in any other build, whatever is set', () => {
    expect(crawlDelayFrom('2000', 'production')).toBeNull()
    expect(crawlDelayFrom('2000', 'test')).toBeNull()
    expect(crawlDelayFrom('2000', undefined)).toBeNull()
  })

  it('is none under test, which is no development build', () => {
    expect(COMMUNITIES_CRAWL_DELAY_MS).toBeNull()
  })
})
