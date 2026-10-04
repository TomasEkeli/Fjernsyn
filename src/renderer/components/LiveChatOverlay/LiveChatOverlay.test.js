import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { YTNodes } from 'youtubei.js'

import LiveChatOverlay from './LiveChatOverlay.vue'
import { mountWithApp } from '../../testing/mount'
import { OVERLAY_QUIET_AFTER_MS } from '../../helpers/liveChat'

vi.mock('../../helpers/api/local', () => ({
  parseLocalTextRuns: runs => runs.map(run => run.text).join(''),
}))

const CHANNEL = 'UCstreamer'

/** The listening half of youtubei.js's `LiveChat`, which the side panel starts */
class FakeLiveChat extends EventTarget {
  listeners = new Map()

  on(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  off(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(l => l !== listener))
  }

  emit(type, value) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(value)
    }
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((count, list) => count + list.length, 0)
  }
}

function node(nodeClass, fields) {
  return Object.assign(Object.create(nodeClass.prototype), { type: nodeClass.type }, fields)
}

let ids = 0

function said(text, author = {}) {
  return node(YTNodes.LiveChatTextMessage, {
    id: `m${++ids}`,
    message: { runs: [{ text }] },
    timestamp: Date.UTC(2026, 9, 4, 14, 5),
    author: { id: 'UCviewer', name: 'Viewer', badges: [], ...author },
  })
}

function update(item) {
  return node(YTNodes.AddChatItemAction, { item })
}

function mountOverlay(props = {}) {
  const liveChat = new FakeLiveChat()
  const wrapper = mountWithApp(LiveChatOverlay, {
    props: { liveChat, channelId: CHANNEL, enabled: true, ...props },
  })

  return { liveChat, wrapper }
}

function texts(wrapper) {
  return wrapper.findAll('.message .text').map(text => text.text())
}

describe('LiveChatOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows each message with its time, its author and what was said, the newest last', async () => {
    const { liveChat, wrapper } = mountOverlay()

    liveChat.emit('chat-update', update(said('first')))
    liveChat.emit('chat-update', update(said('second', { id: CHANNEL, name: 'Streamer' })))
    await nextTick()

    expect(texts(wrapper)).toEqual(['first', 'second'])

    const last = wrapper.findAll('.message').at(-1)
    expect(last.find('time').attributes('datetime')).toBe('2026-10-04T14:05:00.000Z')
    expect(last.find('time').text()).not.toBe('')
    expect(last.find('.name').text()).toBe('Streamer')
    expect(last.find('.name').classes()).toContain('owner')
  })

  it('shows what was said before the chat was opened', async () => {
    const { liveChat, wrapper } = mountOverlay()

    liveChat.emit('start', {
      actions: { filterType: () => [update(said('earlier'))] },
    })
    await nextTick()

    expect(texts(wrapper)).toEqual(['earlier'])
  })

  it('listens while switched off, and shows what it heard once switched on', async () => {
    const { liveChat, wrapper } = mountOverlay({ enabled: false })

    liveChat.emit('chat-update', update(said('while off')))
    await nextTick()

    expect(wrapper.find('.liveChatOverlay').exists()).toBe(false)

    await wrapper.setProps({ enabled: true })

    expect(texts(wrapper)).toEqual(['while off'])
    expect(wrapper.find('.liveChatOverlay').classes()).not.toContain('quiet')
  })

  it('fades after a minute with nothing said, and comes back when something is', async () => {
    const { liveChat, wrapper } = mountOverlay()

    liveChat.emit('chat-update', update(said('hello')))
    await nextTick()

    vi.advanceTimersByTime(OVERLAY_QUIET_AFTER_MS - 1)
    await nextTick()
    expect(wrapper.find('.liveChatOverlay').classes()).not.toContain('quiet')

    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wrapper.find('.liveChatOverlay').classes()).toContain('quiet')

    liveChat.emit('chat-update', update(said('again')))
    await nextTick()
    expect(wrapper.find('.liveChatOverlay').classes()).not.toContain('quiet')
  })

  it('keeps only the latest fifty messages', async () => {
    const { liveChat, wrapper } = mountOverlay()

    for (let i = 0; i < 60; i++) {
      liveChat.emit('chat-update', update(said(`message ${i}`)))
    }
    await nextTick()

    const shown = texts(wrapper)
    expect(shown).toHaveLength(50)
    expect(shown[0]).toBe('message 10')
    expect(shown.at(-1)).toBe('message 59')
  })

  it('stops listening when it goes', () => {
    const { liveChat, wrapper } = mountOverlay()

    expect(liveChat.listenerCount).toBe(2)

    wrapper.unmount()

    expect(liveChat.listenerCount).toBe(0)
  })
})
