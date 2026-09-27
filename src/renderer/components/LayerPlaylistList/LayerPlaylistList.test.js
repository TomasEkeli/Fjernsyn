import { describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import LayerPlaylistList from './LayerPlaylistList.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return { default: createFakeStore({ getters: { getThumbnailPreference: '' } }) }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

const HOST = 'video.blender.org'
const PLAYLIST_ID = '7243ebe1-8a4c-4d1b-9a4f-000000000001'

/** @param {object} [overrides] */
function playlist(overrides = {}) {
  return {
    type: 'playlist',
    platform: 'peertube',
    host: HOST,
    playlistId: PLAYLIST_ID,
    title: 'Open movies',
    thumbnail: `https://${HOST}/lazy-static/thumbnails/playlist.jpg`,
    videoCount: 3,
    url: `https://${HOST}/w/p/${PLAYLIST_ID}`,
    ...overrides,
  }
}

/** @param {object} item */
function mountList(item) {
  return mountWithApp(LayerPlaylistList, { store, props: { playlists: [item] } })
}

describe('LayerPlaylistList, the link out', () => {
  it("links to the playlist's page on its own instance", () => {
    const link = mountList(playlist()).find('.playlistLink')

    expect(link.attributes('href')).toBe(`https://${HOST}/w/p/${PLAYLIST_ID}`)
    expect(link.attributes('title')).toContain(HOST)
  })

  it('offers no link to a URL on another host than the playlist\'s', () => {
    const link = mountList(playlist({ url: `https://evil.example/w/p/${PLAYLIST_ID}` })).find('.playlistLink')

    expect(link.attributes('href')).toBeUndefined()
    expect(link.attributes('title')).toBeUndefined()
  })

  it('offers no link to anything but https', () => {
    for (const url of [`http://${HOST}/w/p/${PLAYLIST_ID}`, `javascript:alert(1)//${HOST}`, 'not a url', '']) {
      expect(mountList(playlist({ url })).find('.playlistLink').attributes('href')).toBeUndefined()
    }
  })

  it('still shows the title and thumbnail without a link', () => {
    const wrapper = mountList(playlist({ url: `https://evil.example/w/p/${PLAYLIST_ID}` }))

    expect(wrapper.find('.playlistTitle').text()).toBe('Open movies')
    expect(wrapper.find('img.playlistThumbnail').exists()).toBe(true)
  })
})
