import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../store/index'
import {
  aiIsShown,
  aiMarkOf,
  allHiddenAsAi,
  isChannelMarkedAi,
  isHiddenAsAi,
  markChannelAi,
  markedAiChannels,
  setAiShown,
  unmarkChannelAi
} from './aiShown'

vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getHideAiVideos: false,
        getAiVerdicts: {},
        getAiChannels: '[]',
      },
    }),
  }
})

const MARKED_CHANNEL = 'UCmarkedmarkedmarkedmark'

const declared = { videoId: 'aiaiaiaiaia', authorId: 'UCsomeoneelsesomeoneelse' }
const notAi = { videoId: 'notainotain', authorId: 'UCsomeoneelsesomeoneelse' }
const unknown = { videoId: 'unknownunkn', authorId: 'UCsomeoneelsesomeoneelse' }
const fromMarked = { videoId: 'frommarkedc', authorId: MARKED_CHANNEL }
const peertube = { videoId: 'aiaiaiaiaia', platform: 'peertube', host: 'video.example', authorId: MARKED_CHANNEL }

describe('aiShown', () => {
  beforeEach(() => {
    store.dispatched.length = 0
    store.setGetter('getHideAiVideos', false)
    store.setGetter('getAiVerdicts', { aiaiaiaiaia: true, notainotain: false })
    store.setGetter('getAiChannels', JSON.stringify([{ id: MARKED_CHANNEL, name: 'Marked' }]))
  })

  it('is the hide-AI setting the other way round', () => {
    expect(aiIsShown()).toBe(true)

    store.setGetter('getHideAiVideos', true)

    expect(aiIsShown()).toBe(false)
  })

  it('sets the setting the pill is pressed against, and only when it changes', () => {
    setAiShown(true)
    expect(store.dispatched).toEqual([])

    setAiShown(false)
    expect(store.dispatched).toEqual([{ type: 'updateHideAiVideos', payload: true }])
  })

  it('marks a video by its verdict or its channel, and nothing else', () => {
    expect(aiMarkOf(declared)).toBe('declared')
    expect(aiMarkOf(fromMarked)).toBe('marked')
    expect(aiMarkOf(notAi)).toBeNull()
    expect(aiMarkOf(unknown)).toBeNull()
    expect(aiMarkOf(peertube)).toBeNull()
  })

  it('says the creator declared it when a marked channel\'s video is also labelled', () => {
    store.setGetter('getAiVerdicts', { [fromMarked.videoId]: true })

    expect(aiMarkOf(fromMarked)).toBe('declared')
  })

  it('hides nothing while AI videos are shown', () => {
    for (const video of [declared, fromMarked, notAi, unknown]) {
      expect(isHiddenAsAi(video)).toBe(false)
    }
  })

  it('hides an ai verdict and a marked channel\'s video while hidden, and leaves not-ai and unknown', () => {
    store.setGetter('getHideAiVideos', true)

    expect(isHiddenAsAi(declared)).toBe(true)
    expect(isHiddenAsAi(fromMarked)).toBe(true)
    expect(isHiddenAsAi(notAi)).toBe(false)
    expect(isHiddenAsAi(unknown)).toBe(false)
    expect(isHiddenAsAi(peertube)).toBe(false)
  })

  it('says everything is hidden only when every entry is, and there are some', () => {
    store.setGetter('getHideAiVideos', true)

    expect(allHiddenAsAi([declared, fromMarked])).toBe(true)
    expect(allHiddenAsAi([declared, unknown])).toBe(false)
    expect(allHiddenAsAi([])).toBe(false)

    store.setGetter('getHideAiVideos', false)

    expect(allHiddenAsAi([declared, fromMarked])).toBe(false)
  })

  it('marks and unmarks a channel in the setting, keeping its name', () => {
    store.setGetter('getAiChannels', '[]')

    markChannelAi('UCnewnewnewnewnewnewnewn', 'New')
    expect(store.dispatched).toEqual([{ type: 'updateAiChannels', payload: JSON.stringify([{ id: 'UCnewnewnewnewnewnewnewn', name: 'New' }]) }])

    store.dispatched.length = 0
    store.setGetter('getAiChannels', JSON.stringify([{ id: MARKED_CHANNEL, name: 'Marked' }, { id: 'UCother', name: 'Other' }]))
    unmarkChannelAi(MARKED_CHANNEL)
    expect(store.dispatched).toEqual([{ type: 'updateAiChannels', payload: JSON.stringify([{ id: 'UCother', name: 'Other' }]) }])
  })

  it('does not mark a channel twice', () => {
    markChannelAi(MARKED_CHANNEL, 'Marked')

    expect(store.dispatched).toEqual([])
  })

  it('reads a setting that is not a list as no channels', () => {
    store.setGetter('getAiChannels', 'nonsense')

    expect(markedAiChannels()).toEqual([])
    expect(isChannelMarkedAi(MARKED_CHANNEL)).toBe(false)
  })
})
