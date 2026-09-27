import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { readFileWithPicker, showToast, writeFileWithPicker } from '../../helpers/utils'
import { createTestRouter } from '../../testing/router'
import { mountWithApp } from '../../testing/mount'
import FtPrompt from '../FtPrompt/FtPrompt.vue'
import DataSettings from './DataSettings.vue'

// Upstream's data settings, for what the fork adds to the subscription import
// and export: PeerTube channel stubs. The YouTube output is pinned string for
// string as the unmodified code wrote it.

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getProfileList: [],
        getEnablePeerTube: true,
      },
    }),
  }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

// The layer the NewPipe import resolves PeerTube accounts through
const layer = vi.hoisted(() => ({ listAccountChannels: null }))

vi.mock('../../platform/vue', () => ({
  getPlatformLayer: () => layer,
}))

vi.mock('../../helpers/utils', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn(),
  readFileWithPicker: vi.fn(),
  writeFileWithPicker: vi.fn(async () => true),
  getTodayDateStrLocalTimezone: () => '2026-09-27',
}))

const YOUTUBE_BLENDER = {
  id: 'UCSMOQeBJ2RAnuFungnQOxLg',
  name: 'Blender',
  thumbnail: 'https://yt3.ggpht.com/blender=s176',
}

const YOUTUBE_QUOTED = {
  id: 'UCBa659QWEk1AI4Tg--mrJ2A',
  name: 'Tom "Scott" & co',
  thumbnail: null,
}

const PEERTUBE_BLENDER = {
  id: 'blender@video.blender.org',
  name: 'Blender Studio',
  thumbnail: 'https://video.blender.org/lazy-static/avatars/blender.png',
  platform: 'peertube',
  host: 'video.blender.org',
}

function mainProfile(subscriptions) {
  return {
    _id: 'allChannels',
    name: 'All Channels',
    bgColor: '#000000',
    textColor: '#FFFFFF',
    subscriptions,
  }
}

const NOW = new Date('2026-09-27T12:00:00.000Z')

beforeEach(() => {
  // the export prompt teleports into the app's root element
  document.body.innerHTML = '<div class="app"></div>'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  store.dispatched.length = 0
  store.committed.length = 0
  store.setGetter('getProfileList', [mainProfile([YOUTUBE_BLENDER, PEERTUBE_BLENDER, YOUTUBE_QUOTED])])
  store.setGetter('getEnablePeerTube', true)
  vi.mocked(showToast).mockClear()
  vi.mocked(writeFileWithPicker).mockClear()
  vi.mocked(readFileWithPicker).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

function mountDataSettings() {
  return mountWithApp(DataSettings, { store, router: createTestRouter() })
}

function button(wrapper, label) {
  return wrapper.findAll('button').find(candidate => candidate.text() === label)
}

async function exportSubscriptions(option) {
  const wrapper = mountDataSettings()
  await button(wrapper, 'Export Subscriptions').trigger('click')
  wrapper.findComponent(FtPrompt).vm.$emit('click', option)
  await flushPromises()

  expect(writeFileWithPicker).toHaveBeenCalledTimes(1)
  const [fileName, content] = vi.mocked(writeFileWithPicker).mock.calls[0]
  return { fileName, content }
}

async function importSubscriptionsFrom(filename, content) {
  vi.mocked(readFileWithPicker).mockResolvedValue({ filename, content })
  const wrapper = mountDataSettings()
  await button(wrapper, 'Import Subscriptions').trigger('click')
  await flushPromises()
}

function updatedProfiles() {
  return store.dispatched.filter(action => action.type === 'updateProfile').map(action => action.payload)
}

function toasts() {
  return vi.mocked(showToast).mock.calls.map(([message]) => message)
}

describe('the YouTube-format subscription exports', () => {
  it('writes the CSV with YouTube channels only, as it always has', async () => {
    const { fileName, content } = await exportSubscriptions('youtubenew')

    expect(fileName).toBe('youtube-subscriptions-2026-09-27.csv')
    expect(content).toBe(
      'Channel ID,Channel URL,Channel title\n' +
      'UCSMOQeBJ2RAnuFungnQOxLg,https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg,"Blender"\n' +
      'UCBa659QWEk1AI4Tg--mrJ2A,https://www.youtube.com/channel/UCBa659QWEk1AI4Tg--mrJ2A,"Tom ""Scott"" & co"\n' +
      '\n'
    )
  })

  it('writes the OPML with YouTube channels only, as it always has', async () => {
    const { fileName, content } = await exportSubscriptions('youtubeold')

    expect(fileName).toBe('youtube-subscriptions-2026-09-27.opml')
    expect(content).toBe(
      '<opml version="1.1"><body><outline text="YouTube Subscriptions" title="YouTube Subscriptions">' +
      '<outline text="Blender" title="Blender" type="rss" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UCSMOQeBJ2RAnuFungnQOxLg"/>' +
      '<outline text="Tom &quot;Scott&quot; &amp; co" title="Tom &quot;Scott&quot; &amp; co" type="rss" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UCBa659QWEk1AI4Tg--mrJ2A"/>' +
      '</outline></body></opml>'
    )
  })

  it('writes the JSON with YouTube channels only, as it always has', async () => {
    const { fileName, content } = await exportSubscriptions('youtube')

    const entry = (channel) => ({
      contentDetails: { activityType: 'all', newItemCount: 0, totalItemCount: 0 },
      etag: '',
      id: '',
      kind: 'youtube#subscription',
      snippet: {
        channelId: channel.id,
        description: '',
        publishedAt: NOW,
        resourceId: { channelId: channel.id, kind: 'youtube#channel' },
        thumbnails: {
          default: { url: channel.thumbnail },
          high: { url: channel.thumbnail },
          medium: { url: channel.thumbnail },
        },
        title: channel.name,
      },
    })

    expect(fileName).toBe('youtube-subscriptions-2026-09-27.json')
    expect(content).toBe(JSON.stringify([entry(YOUTUBE_BLENDER), entry(YOUTUBE_QUOTED)]))
  })
})

describe('the NewPipe subscription export', () => {
  it('writes YouTube entries as it always has, and PeerTube channels as service 3 on their origin', async () => {
    const { fileName, content } = await exportSubscriptions('newpipe')

    expect(fileName).toBe('newpipe-subscriptions-2026-09-27.json')
    expect(content).toBe(JSON.stringify({
      app_version: '0.19.8',
      app_version_int: 953,
      subscriptions: [
        { service_id: 0, url: 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender' },
        { service_id: 3, url: 'https://video.blender.org/video-channels/blender', name: 'Blender Studio' },
        { service_id: 0, url: 'https://www.youtube.com/channel/UCBa659QWEk1AI4Tg--mrJ2A', name: 'Tom "Scott" & co' },
      ],
    }))
  })

  it('is unchanged for a YouTube-only profile', async () => {
    store.setGetter('getProfileList', [mainProfile([YOUTUBE_BLENDER])])

    const { content } = await exportSubscriptions('newpipe')

    expect(content).toBe(
      '{"app_version":"0.19.8","app_version_int":953,"subscriptions":[' +
      '{"service_id":0,"url":"https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg","name":"Blender"}]}'
    )
  })
})

describe('the Fjernsyn subscription export and import', () => {
  it('writes every profile as a line of JSON, PeerTube stubs with all their fields', async () => {
    const peerTubeProfile = { _id: 'p1', name: 'PeerTube', bgColor: '#111111', textColor: '#EEEEEE', subscriptions: [PEERTUBE_BLENDER] }
    store.setGetter('getProfileList', [mainProfile([YOUTUBE_BLENDER, PEERTUBE_BLENDER]), peerTubeProfile])

    const { fileName, content } = await exportSubscriptions('freetube')

    expect(fileName).toBe('fjernsyn-subscriptions-2026-09-27.db')
    expect(content).toBe(
      JSON.stringify(mainProfile([YOUTUBE_BLENDER, PEERTUBE_BLENDER])) + '\n' +
      JSON.stringify(peerTubeProfile) + '\n'
    )
  })

  it('round-trips YouTube and PeerTube stubs, keeping every field', async () => {
    const peerTubeProfile = { _id: 'p1', name: 'PeerTube', bgColor: '#111111', textColor: '#EEEEEE', subscriptions: [PEERTUBE_BLENDER] }
    store.setGetter('getProfileList', [mainProfile([YOUTUBE_BLENDER, PEERTUBE_BLENDER]), peerTubeProfile])
    const { content } = await exportSubscriptions('freetube')

    store.setGetter('getProfileList', [mainProfile([])])
    store.dispatched.length = 0
    await importSubscriptionsFrom('fjernsyn-subscriptions-2026-09-27.db', content)

    const profiles = updatedProfiles()
    expect(profiles.find(profile => profile._id === 'p1')).toEqual(peerTubeProfile)
    expect(profiles.filter(profile => profile._id === 'allChannels').at(-1).subscriptions)
      .toEqual([YOUTUBE_BLENDER, PEERTUBE_BLENDER])
  })
})

describe('the NewPipe subscription import', () => {
  const NEWPIPE_EXPORT = JSON.stringify({
    app_version: '0.27.0',
    app_version_int: 1000,
    subscriptions: [
      { service_id: 0, url: 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender' },
      { service_id: 3, url: 'https://framatube.org/video-channels/blender@video.blender.org', name: 'Blender Studio' },
      { service_id: 3, url: 'https://framatube.org/accounts/framasoft', name: 'Framasoft' },
      { service_id: 1, url: 'https://soundcloud.com/blender', name: 'Blender' },
    ],
  })

  const IMPORTED_PEERTUBE = {
    id: 'blender@video.blender.org',
    name: 'Blender Studio',
    thumbnail: '',
    platform: 'peertube',
    host: 'video.blender.org',
  }

  /** A channel summary, as the layer's listAccountChannels gives them */
  function summary(name, host, displayName, thumbnail = '') {
    return {
      platform: 'peertube',
      host,
      id: `${name}@${host}`,
      handle: `${name}@${host}`,
      name: displayName,
      thumbnail,
      url: `https://${host}/video-channels/${name}`,
      subscriberCount: 1,
    }
  }

  const FRAMASOFT_CHANNELS = [
    summary('framasoft_channel', 'framatube.org', 'Framasoft', 'https://framatube.org/lazy-static/avatars/f.png'),
    summary('framablog', 'framatube.org', 'Framablog'),
  ]

  const IMPORTED_FRAMASOFT = [
    { id: 'framasoft_channel@framatube.org', name: 'Framasoft', thumbnail: 'https://framatube.org/lazy-static/avatars/f.png', platform: 'peertube', host: 'framatube.org' },
    { id: 'framablog@framatube.org', name: 'Framablog', thumbnail: '', platform: 'peertube', host: 'framatube.org' },
  ]

  beforeEach(() => {
    store.setGetter('getProfileList', [mainProfile([])])
    layer.listAccountChannels = vi.fn(async (handle) => {
      if (handle === 'framasoft@framatube.org') {
        return FRAMASOFT_CHANNELS
      }
      throw Object.assign(new Error(`no account ${handle}`), { kind: 'notFound' })
    })
  })

  it('imports YouTube channels as it always has, PeerTube channels as their stubs, and a PeerTube account as all its channels', async () => {
    await importSubscriptionsFrom('newpipe.json', NEWPIPE_EXPORT)

    const [profile] = updatedProfiles()
    expect(profile.subscriptions).toEqual([
      { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: null },
      IMPORTED_PEERTUBE,
      ...IMPORTED_FRAMASOFT,
    ])
    expect(Object.keys(profile.subscriptions[0])).toEqual(['id', 'name', 'thumbnail'])
    expect(layer.listAccountChannels.mock.calls).toEqual([['framasoft@framatube.org']])
    expect(toasts()).toEqual([
      '3 PeerTube channels imported',
      'All subscriptions have been successfully imported',
    ])
  })

  it('skips an account that could not be resolved, and an entry it cannot read, and says how many', async () => {
    await importSubscriptionsFrom('newpipe.json', JSON.stringify({
      subscriptions: [
        { service_id: 3, url: 'https://framatube.org/accounts/gone', name: 'Gone' },
        { service_id: 3, url: 'https://framatube.org/accounts/framasoft', name: 'Framasoft' },
        { service_id: 3, url: 'https://framatube.org/w/abc', name: 'A video' },
      ],
    }))

    expect(updatedProfiles()[0].subscriptions).toEqual(IMPORTED_FRAMASOFT)
    expect(toasts()).toContain('2 PeerTube channels imported')
    expect(toasts()).toContain('2 PeerTube subscriptions could not be imported')
  })

  it('imports an account\'s channel once, already followed, followed directly too, or through a second account entry', async () => {
    store.setGetter('getProfileList', [mainProfile([IMPORTED_FRAMASOFT[1]])])

    await importSubscriptionsFrom('newpipe.json', JSON.stringify({
      subscriptions: [
        { service_id: 3, url: 'https://framatube.org/video-channels/framasoft_channel', name: 'Framasoft' },
        { service_id: 3, url: 'https://framatube.org/accounts/framasoft', name: 'Framasoft' },
        { service_id: 3, url: 'https://video.blender.org/accounts/framasoft@framatube.org', name: 'Framasoft' },
      ],
    }))

    expect(layer.listAccountChannels).toHaveBeenCalledTimes(1)
    expect(updatedProfiles()[0].subscriptions).toEqual([
      IMPORTED_FRAMASOFT[1],
      { id: 'framasoft_channel@framatube.org', name: 'Framasoft', thumbnail: '', platform: 'peertube', host: 'framatube.org' },
    ])
    expect(toasts()).toContain('1 PeerTube channel imported')
  })

  it('resolves two accounts at a time', async () => {
    let inFlight = 0
    let maxInFlight = 0
    layer.listAccountChannels = vi.fn(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 0))
      inFlight--
      return []
    })

    await importSubscriptionsFrom('newpipe.json', JSON.stringify({
      subscriptions: ['a', 'b', 'c', 'd', 'e'].map(name => ({ service_id: 3, url: `https://framatube.org/accounts/${name}`, name })),
    }))
    await vi.waitFor(() => expect(updatedProfiles()).toHaveLength(1))

    expect(layer.listAccountChannels).toHaveBeenCalledTimes(5)
    expect(maxInFlight).toBe(2)
  })

  it('does not import a PeerTube channel already subscribed to', async () => {
    store.setGetter('getProfileList', [mainProfile([IMPORTED_PEERTUBE])])

    await importSubscriptionsFrom('newpipe.json', NEWPIPE_EXPORT)

    expect(updatedProfiles()[0].subscriptions).toEqual([
      IMPORTED_PEERTUBE,
      { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: null },
      ...IMPORTED_FRAMASOFT,
    ])
  })

  it('imports a PeerTube channel once when NewPipe followed it through two instances', async () => {
    await importSubscriptionsFrom('newpipe.json', JSON.stringify({
      subscriptions: [
        { service_id: 3, url: 'https://framatube.org/video-channels/blender@video.blender.org', name: 'Blender Studio' },
        { service_id: 3, url: 'https://video.blender.org/video-channels/blender', name: 'Blender Studio' },
      ],
    }))

    expect(updatedProfiles()[0].subscriptions).toEqual([IMPORTED_PEERTUBE])
    expect(toasts()).toContain('1 PeerTube channel imported')
  })

  it('imports only the YouTube channels while PeerTube is off, as it always has, and says what it left out', async () => {
    store.setGetter('getEnablePeerTube', false)

    await importSubscriptionsFrom('newpipe.json', NEWPIPE_EXPORT)

    expect(updatedProfiles()[0].subscriptions).toEqual([
      { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: null },
    ])
    expect(layer.listAccountChannels).not.toHaveBeenCalled()
    expect(toasts()).toContain('2 PeerTube subscriptions were not imported: PeerTube is switched off. Switch it on in Experimental settings and import again')
    expect(toasts()).toContain('All subscriptions have been successfully imported')
  })

  it('says nothing about PeerTube for an export without PeerTube entries', async () => {
    await importSubscriptionsFrom('newpipe.json', JSON.stringify({
      subscriptions: [{ service_id: 0, url: 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender' }],
    }))

    expect(toasts()).toEqual(['All subscriptions have been successfully imported'])
  })
})
