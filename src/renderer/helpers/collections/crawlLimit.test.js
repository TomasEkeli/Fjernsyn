import { describe, expect, it } from 'vitest'

import { COLLECTIONS_CRAWL_LIMIT, crawlLimitFrom } from './crawlLimit'

describe('the crawl\'s development limit', () => {
  it('is the number set, in a development build', () => {
    expect(crawlLimitFrom('30', 'development')).toBe(30)
    expect(crawlLimitFrom('0', 'development')).toBe(0)
  })

  it('is no limit when nothing is set', () => {
    expect(crawlLimitFrom('', 'development')).toBeNull()
    expect(crawlLimitFrom(undefined, 'development')).toBeNull()
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
    expect(COLLECTIONS_CRAWL_LIMIT).toBeNull()
  })
})
