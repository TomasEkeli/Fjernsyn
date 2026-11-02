import { describe, expect, it } from 'vitest'

import { stripTrackingParams } from './trackingParams'

describe('stripTrackingParams', () => {
  it('removes every utm_ parameter, not only the five common ones', () => {
    expect(stripTrackingParams('https://example.org/page?utm_source=youtube&utm_medium=video&utm_id=7&utm_source_platform=yt'))
      .toBe('https://example.org/page')
  })

  it('removes click identifiers of ad and social networks', () => {
    expect(stripTrackingParams('https://example.org/?fbclid=a&gclid=b&msclkid=c&igshid=d&ttclid=e&twclid=f&mc_cid=g&mc_eid=h&_hsenc=i&_hsmi=j&mkt_tok=k'))
      .toBe('https://example.org/')
  })

  it('keeps the parameters the link needs, in their order', () => {
    expect(stripTrackingParams('https://example.org/shop?item=42&utm_campaign=x&colour=blue#reviews'))
      .toBe('https://example.org/shop?item=42&colour=blue#reviews')
  })

  it('returns the link exactly as given when there is nothing to remove', () => {
    const url = 'https://example.org/a%20b?q=a+b&x=%2F'
    expect(stripTrackingParams(url)).toBe(url)
  })

  it('removes the share identifier si on YouTube and Spotify links', () => {
    expect(stripTrackingParams('https://youtu.be/dQw4w9WgXcQ?si=abc&t=42')).toBe('https://youtu.be/dQw4w9WgXcQ?t=42')
    expect(stripTrackingParams('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(stripTrackingParams('https://open.spotify.com/track/1?si=abc')).toBe('https://open.spotify.com/track/1')
  })

  it('leaves si alone on other sites, where it may be the page\'s own parameter', () => {
    const url = 'https://example.org/search?si=3'
    expect(stripTrackingParams(url)).toBe(url)
  })

  it('leaves links that are not http or https, or not links at all, as they are', () => {
    expect(stripTrackingParams('mailto:someone@example.org?utm_source=x')).toBe('mailto:someone@example.org?utm_source=x')
    expect(stripTrackingParams('not a url')).toBe('not a url')
  })
})
