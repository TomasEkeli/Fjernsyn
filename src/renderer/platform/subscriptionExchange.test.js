import { describe, expect, it } from 'vitest'

import {
  NEWPIPE_SERVICE_PEERTUBE,
  isYouTubeChannelStub,
  newPipeEntryKind,
  newPipeEntryToChannel,
  peerTubeChannelsFromNewPipe,
  peerTubeStubToNewPipeEntry,
  resolveNewPipeAccounts,
} from './subscriptionExchange'

const BLENDER_STUB = {
  id: 'blender@video.blender.org',
  name: 'Blender',
  thumbnail: '',
  platform: 'peertube',
  host: 'video.blender.org',
}

describe('the NewPipe service ids', () => {
  it('reads PeerTube as service 3, as NewPipeExtractor\'s ServiceList numbers it', () => {
    expect(NEWPIPE_SERVICE_PEERTUBE).toBe(3)
  })
})

describe('newPipeEntryToChannel', () => {
  it('turns a YouTube entry into the stub today\'s import stores', () => {
    const channel = newPipeEntryToChannel({
      service_id: 0,
      url: 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg',
      name: 'Blender',
    })

    expect(channel).toEqual({ id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: null })
    expect(Object.keys(channel)).toEqual(['id', 'name', 'thumbnail'])
  })

  it('turns a PeerTube video channel on its origin into a PeerTube stub', () => {
    expect(newPipeEntryToChannel({
      service_id: 3,
      url: 'https://video.blender.org/video-channels/blender',
      name: 'Blender',
    })).toEqual(BLENDER_STUB)
  })

  it('takes a channel shown by another instance to its origin', () => {
    expect(newPipeEntryToChannel({
      service_id: 3,
      url: 'https://framatube.org/video-channels/blender@Video.Blender.org',
      name: 'Blender',
    })).toEqual(BLENDER_STUB)
  })

  it('reads the short channel path and a trailing tab', () => {
    expect(newPipeEntryToChannel({
      service_id: 3,
      url: 'https://Video.Blender.org/c/blender/videos',
      name: 'Blender',
    })).toEqual(BLENDER_STUB)
  })

  it('skips a PeerTube account, which is not a channel', () => {
    expect(newPipeEntryToChannel({
      service_id: 3,
      url: 'https://video.blender.org/accounts/blender',
      name: 'Blender',
    })).toBeNull()
    expect(newPipeEntryToChannel({
      service_id: 3,
      url: 'https://framatube.org/a/blender@video.blender.org',
      name: 'Blender',
    })).toBeNull()
  })

  it('never takes a YouTube or Google host for PeerTube', () => {
    expect(newPipeEntryToChannel({
      service_id: 3,
      url: 'https://youtube.com/c/blender',
      name: 'Blender',
    })).toBeNull()
    expect(newPipeEntryToChannel({
      service_id: 3,
      url: 'https://framatube.org/video-channels/blender@www.youtube.com',
      name: 'Blender',
    })).toBeNull()
  })

  it('answers null for other services and malformed entries', () => {
    expect(newPipeEntryToChannel({ service_id: 1, url: 'https://soundcloud.com/blender', name: 'Blender' })).toBeNull()
    expect(newPipeEntryToChannel({ service_id: 2, url: 'https://media.ccc.de/c/36c3', name: '36C3' })).toBeNull()
    expect(newPipeEntryToChannel({ service_id: 3, url: 'not a url', name: 'Blender' })).toBeNull()
    expect(newPipeEntryToChannel({ service_id: 3, url: 'https://video.blender.org/w/abc', name: 'Blender' })).toBeNull()
    expect(newPipeEntryToChannel({ service_id: 3, name: 'Blender' })).toBeNull()
    expect(newPipeEntryToChannel(null)).toBeNull()
  })

  it('keeps an empty name when NewPipe gave none', () => {
    expect(newPipeEntryToChannel({
      service_id: 3,
      url: 'https://video.blender.org/video-channels/blender',
    })).toEqual({ ...BLENDER_STUB, name: '' })
  })
})

describe('newPipeEntryKind', () => {
  it.each([
    ['https://video.blender.org/video-channels/blender', 'channel', 'blender@video.blender.org'],
    ['https://framatube.org/c/blender@Video.Blender.org/videos', 'channel', 'blender@video.blender.org'],
    ['https://video.blender.org/accounts/blender', 'account', 'blender@video.blender.org'],
    ['https://Video.Blender.org/accounts/blender/video-channels', 'account', 'blender@video.blender.org'],
    ['https://framatube.org/accounts/blender@video.blender.org', 'account', 'blender@video.blender.org'],
    ['https://framatube.org/a/blender@video.blender.org/', 'account', 'blender@video.blender.org'],
    ['https://framatube.org/accounts/bl%C3%A9nder', 'account', null],
  ])('reads %s as a %s, %s', (url, kind, handle) => {
    const answer = newPipeEntryKind({ service_id: 3, url, name: 'Blender' })

    expect(answer).toEqual(handle === null ? null : { kind, handle })
  })

  it.each([
    'https://www.youtube.com/accounts/blender',
    'https://youtube.com/a/blender',
    'https://framatube.org/accounts/blender@www.youtube.com',
    'https://framatube.org:8443/accounts/blender',
    'ftp://framatube.org/accounts/blender',
    'https://framatube.org/accounts/',
    'https://framatube.org/accounts/a@b@c.example',
    'https://video.blender.org/w/abc',
    'not a url',
  ])('answers null for %s', (url) => {
    expect(newPipeEntryKind({ service_id: 3, url, name: 'Blender' })).toBeNull()
  })

  it('answers null for other services and malformed entries', () => {
    expect(newPipeEntryKind({ service_id: 0, url: 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg' })).toBeNull()
    expect(newPipeEntryKind({ service_id: 1, url: 'https://soundcloud.com/accounts/blender' })).toBeNull()
    expect(newPipeEntryKind({ service_id: 3 })).toBeNull()
    expect(newPipeEntryKind(null)).toBeNull()
  })
})

describe('peerTubeChannelsFromNewPipe', () => {
  it('picks the PeerTube channels and accounts out of an export and counts the PeerTube entries it cannot read', () => {
    const result = peerTubeChannelsFromNewPipe([
      { service_id: 0, url: 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender' },
      { service_id: 3, url: 'https://video.blender.org/video-channels/blender', name: 'Blender' },
      { service_id: 3, url: 'https://video.blender.org/accounts/blender', name: 'Blender' },
      { service_id: 3, url: 'https://video.blender.org/w/abc', name: 'A video' },
      { service_id: 1, url: 'https://soundcloud.com/blender', name: 'Blender' },
    ])

    expect(result).toEqual({ channels: [BLENDER_STUB], accounts: ['blender@video.blender.org'], skipped: 1 })
  })

  it('names an account once, however many instances NewPipe followed it through', () => {
    expect(peerTubeChannelsFromNewPipe([
      { service_id: 3, url: 'https://video.blender.org/accounts/blender', name: 'Blender' },
      { service_id: 3, url: 'https://framatube.org/accounts/blender@video.blender.org', name: 'Blender' },
    ]).accounts).toEqual(['blender@video.blender.org'])
  })

  it('answers nothing for an export without PeerTube entries', () => {
    expect(peerTubeChannelsFromNewPipe([
      { service_id: 0, url: 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender' },
    ])).toEqual({ channels: [], accounts: [], skipped: 0 })
    expect(peerTubeChannelsFromNewPipe(undefined)).toEqual({ channels: [], accounts: [], skipped: 0 })
  })
})

describe('resolveNewPipeAccounts', () => {
  /** A channel summary, as the layer's listAccountChannels gives them */
  function summary(name, host, thumbnail = '') {
    return {
      platform: 'peertube',
      host,
      id: `${name}@${host}`,
      handle: `${name}@${host}`,
      name: `Display ${name}`,
      thumbnail,
      url: `https://${host}/video-channels/${name}`,
      subscriberCount: 3,
    }
  }

  /** A fake layer answering from a table, after the test lets it */
  function fakeLayer(answers) {
    const pending = []
    let inFlight = 0
    let maxInFlight = 0
    const asked = []

    return {
      asked,
      get maxInFlight() { return maxInFlight },
      settleAll: async () => {
        while (pending.length > 0) {
          pending.shift()()
          await Promise.resolve()
          await Promise.resolve()
        }
      },
      listAccountChannels(handle) {
        asked.push(handle)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        return new Promise((resolve, reject) => {
          pending.push(() => {
            inFlight--
            const answer = answers[handle]
            if (answer instanceof Error) {
              reject(answer)
            } else {
              resolve(answer)
            }
          })
        })
      },
    }
  }

  it('turns every account into the stubs of all its channels, in the accounts\' order', async () => {
    const layer = fakeLayer({
      'blender@video.blender.org': [summary('blender_studio', 'video.blender.org', 'https://video.blender.org/a.webp'), summary('blender_dev', 'video.blender.org')],
      'framasoft@framatube.org': [summary('framasoft', 'framatube.org')],
    })

    const resolution = resolveNewPipeAccounts(['blender@video.blender.org', 'framasoft@framatube.org'], layer)
    await layer.settleAll()

    expect(await resolution).toEqual({
      channels: [
        { id: 'blender_studio@video.blender.org', name: 'Display blender_studio', thumbnail: 'https://video.blender.org/a.webp', platform: 'peertube', host: 'video.blender.org' },
        { id: 'blender_dev@video.blender.org', name: 'Display blender_dev', thumbnail: '', platform: 'peertube', host: 'video.blender.org' },
        { id: 'framasoft@framatube.org', name: 'Display framasoft', thumbnail: '', platform: 'peertube', host: 'framatube.org' },
      ],
      failed: 0,
    })
  })

  it('asks two accounts at a time', async () => {
    const accounts = ['a@one.example', 'b@one.example', 'c@two.example', 'd@two.example', 'e@three.example']
    const layer = fakeLayer(Object.fromEntries(accounts.map(account => [account, []])))

    const resolution = resolveNewPipeAccounts(accounts, layer)
    await Promise.resolve()

    expect(layer.asked).toEqual(['a@one.example', 'b@one.example'])

    await layer.settleAll()
    await resolution

    expect(layer.asked).toEqual(accounts)
    expect(layer.maxInFlight).toBe(2)
  })

  it('skips an account that could not be resolved, counts it, and resolves the rest', async () => {
    const layer = fakeLayer({
      'gone@video.blender.org': Object.assign(new Error('not found'), { kind: 'notFound' }),
      'blender@video.blender.org': [summary('blender_studio', 'video.blender.org')],
      'down@tube.example': new TypeError('Failed to fetch'),
    })

    const resolution = resolveNewPipeAccounts(['gone@video.blender.org', 'blender@video.blender.org', 'down@tube.example'], layer)
    await layer.settleAll()

    const { channels, failed } = await resolution
    expect(channels.map(channel => channel.id)).toEqual(['blender_studio@video.blender.org'])
    expect(failed).toBe(2)
  })

  it('leaves out a summary that is not a PeerTube channel\'s', async () => {
    const layer = fakeLayer({
      'blender@video.blender.org': [{ ...summary('x', 'video.blender.org'), handle: 'not a handle', id: 'not a handle' }, null],
    })

    const resolution = resolveNewPipeAccounts(['blender@video.blender.org'], layer)
    await layer.settleAll()

    expect(await resolution).toEqual({ channels: [], failed: 0 })
  })

  it('asks nothing when there are no accounts', async () => {
    const layer = fakeLayer({})

    expect(await resolveNewPipeAccounts([], layer)).toEqual({ channels: [], failed: 0 })
    expect(layer.asked).toEqual([])
  })
})

describe('isYouTubeChannelStub', () => {
  it('is true for a stub without a platform, as every stub written before PeerTube', () => {
    expect(isYouTubeChannelStub({ id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: null })).toBe(true)
    expect(isYouTubeChannelStub({ id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', platform: 'youtube' })).toBe(true)
  })

  it('is false for a PeerTube stub', () => {
    expect(isYouTubeChannelStub(BLENDER_STUB)).toBe(false)
  })
})

describe('peerTubeStubToNewPipeEntry', () => {
  it('writes the channel\'s URL on its origin with the PeerTube service id', () => {
    expect(peerTubeStubToNewPipeEntry(BLENDER_STUB)).toEqual({
      service_id: 3,
      url: 'https://video.blender.org/video-channels/blender',
      name: 'Blender',
    })
  })

  it('reads an entry it wrote back to the same stub', () => {
    const entry = peerTubeStubToNewPipeEntry(BLENDER_STUB)

    expect(newPipeEntryToChannel(entry)).toEqual(BLENDER_STUB)
  })

  it('answers null for a stub whose handle is not a PeerTube channel\'s', () => {
    expect(peerTubeStubToNewPipeEntry({ ...BLENDER_STUB, id: 'not a handle' })).toBeNull()
    expect(peerTubeStubToNewPipeEntry({ id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: null })).toBeNull()
  })
})
