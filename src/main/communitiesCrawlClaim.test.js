import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { createCommunitiesCrawlClaim } from './communitiesCrawlClaim'

let nextId = 1

/** A window's web contents, as far as the claim looks at them */
function contents() {
  const emitter = new EventEmitter()
  emitter.id = nextId++
  return emitter
}

describe('the claim on the Communities crawl', () => {
  it('grants the crawl to the first window to ask, and to no other while it holds it', () => {
    const claim = createCommunitiesCrawlClaim()
    const first = contents()
    const second = contents()

    expect(claim.claim(first)).toBe(true)
    expect(claim.claim(second)).toBe(false)
    expect(claim.holder()).toBe(first.id)
  })

  it('grants it again to the window that holds it', () => {
    const claim = createCommunitiesCrawlClaim()
    const first = contents()

    claim.claim(first)

    expect(claim.claim(first)).toBe(true)
  })

  it('passes once the holder gives it back, and not when another window says it does', () => {
    const claim = createCommunitiesCrawlClaim()
    const first = contents()
    const second = contents()
    claim.claim(first)

    claim.release(second)
    expect(claim.claim(second)).toBe(false)

    claim.release(first)
    expect(claim.claim(second)).toBe(true)
  })

  it('is let go when the holding window closes, crashes, or loads a page again', () => {
    for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
      const claim = createCommunitiesCrawlClaim()
      const first = contents()
      claim.claim(first)

      first.emit(event)

      expect(claim.holder(), event).toBeNull()
      expect(claim.claim(contents()), event).toBe(true)
    }
  })

  it('is let go each time the holding window loads a page again, not only the first', () => {
    const claim = createCommunitiesCrawlClaim()
    const first = contents()

    claim.claim(first)
    first.emit('did-navigate')
    claim.claim(first)
    first.emit('did-navigate')

    expect(claim.holder()).toBeNull()
  })

  it('is not let go by what a window that no longer holds it does', () => {
    const claim = createCommunitiesCrawlClaim()
    const first = contents()
    const second = contents()
    claim.claim(first)
    claim.release(first)
    claim.claim(second)

    first.emit('destroyed')

    expect(claim.holder()).toBe(second.id)
  })

  it('watches a window once, however often it claims', () => {
    const claim = createCommunitiesCrawlClaim()
    const first = contents()

    claim.claim(first)
    claim.claim(first)
    claim.release(first)
    claim.claim(first)

    expect(first.listenerCount('destroyed')).toBe(1)
  })
})
