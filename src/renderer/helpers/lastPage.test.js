import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { HOME_PAGE, pageToRestore, rememberPage } from './lastPage'

function createStorage() {
  const items = new Map()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
  }
}

const Stub = { render: () => null }

// The app's router has no catch-all: a path it does not know matches nothing
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'default', component: Stub },
    { path: '/about', name: 'about', component: Stub },
    { path: '/subscriptions', name: 'subscriptions', component: Stub },
    { path: '/channel/:id/:currentTab?', name: 'channel', component: Stub },
    { path: '/search/:query', name: 'search', component: Stub },
    { path: '/watch/:id', name: 'watch', component: Stub },
    { path: '/peertube/watch/:host/:uuid', name: 'peertubeWatch', component: Stub },
  ],
})

describe('lastPage', () => {
  it('opens the first start on the test card', () => {
    expect(HOME_PAGE).toBe('/about')
    expect(pageToRestore(router, createStorage())).toBe('/about')
  })

  it('reopens the page the reader was last on', () => {
    const storage = createStorage()

    rememberPage('/subscriptions', storage)

    expect(pageToRestore(router, storage)).toBe('/subscriptions')
  })

  it('reopens the exact page, its parameters and query included', () => {
    const storage = createStorage()

    rememberPage('/channel/UC123/videos', storage)
    expect(pageToRestore(router, storage)).toBe('/channel/UC123/videos')

    rememberPage('/search/tv?sortBy=date', storage)
    expect(pageToRestore(router, storage)).toBe('/search/tv?sortBy=date')
  })

  it('passes over a video, so the next start opens the page before it', () => {
    const storage = createStorage()

    rememberPage('/channel/UC123', storage)
    rememberPage('/watch/abc', storage)
    rememberPage('/peertube/watch/example.com/def', storage)

    expect(pageToRestore(router, storage)).toBe('/channel/UC123')
  })

  it('passes over the bare start path, which is only ever on the way somewhere', () => {
    const storage = createStorage()

    rememberPage('/about', storage)
    rememberPage('/', storage)

    expect(pageToRestore(router, storage)).toBe('/about')
  })

  it('falls back to the test card for a remembered page the app no longer has', () => {
    const storage = createStorage()
    storage.setItem('lastPage', '/gone')

    expect(pageToRestore(router, storage)).toBe('/about')
  })

  it('falls back to the test card when storage cannot be read or written', () => {
    const broken = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }

    expect(() => rememberPage('/subscriptions', broken)).not.toThrow()
    expect(pageToRestore(router, broken)).toBe('/about')
  })
})
