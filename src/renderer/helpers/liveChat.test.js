import { describe, expect, it, vi } from 'vitest'
import { YTNodes } from 'youtubei.js'

import { chatAuthorName, chatTimeAttribute, formatChatTime, parseOverlayChatItem } from './liveChat'

vi.mock('./api/local', () => ({
  parseLocalTextRuns: runs => runs.map(run => run.text).join(''),
}))

const CHANNEL = 'UCstreamer'
// 2026-10-04 14:05:09 UTC
const WRITTEN = Date.UTC(2026, 9, 4, 14, 5, 9)

/**
 * A node of the given youtubei.js class, as the chat hands them over
 *
 * @param {any} nodeClass
 * @param {object} fields
 */
function node(nodeClass, fields) {
  return Object.assign(Object.create(nodeClass.prototype), { type: nodeClass.type }, fields)
}

function textMessage(author = {}, fields = {}) {
  return node(YTNodes.LiveChatTextMessage, {
    id: 'm1',
    message: { runs: [{ text: 'hello ' }, { text: 'world' }] },
    timestamp: WRITTEN,
    author: { id: 'UCviewer', name: 'Viewer', is_moderator: false, badges: [], ...author },
    ...fields,
  })
}

describe('formatChatTime', () => {
  it('is the time of day the message was written, without seconds', () => {
    expect(formatChatTime(WRITTEN, ['en-GB'])).toBe(new Intl.DateTimeFormat(['en-GB'], { hour: 'numeric', minute: '2-digit' }).format(WRITTEN))
    expect(formatChatTime(WRITTEN, ['en-GB'])).not.toContain(':09')
  })

  it('is nothing where the time is not known', () => {
    expect(formatChatTime(NaN, ['en-US'])).toBe('')
    expect(chatTimeAttribute(NaN)).toBeUndefined()
  })

  it('gives the time to a time element in full', () => {
    expect(chatTimeAttribute(WRITTEN)).toBe('2026-10-04T14:05:09.000Z')
  })
})

describe('parseOverlayChatItem', () => {
  it('reads a text message: who, what and when', () => {
    expect(parseOverlayChatItem(textMessage(), CHANNEL)).toEqual({
      id: 'm1',
      author: { name: 'Viewer', isOwner: false, isModerator: false, isMember: false },
      message: 'hello world',
      timestamp: WRITTEN,
      amount: null,
    })
  })

  it('knows the streamer, a moderator and a member', () => {
    const memberBadge = node(YTNodes.LiveChatAuthorBadge, { custom_thumbnail: [{ url: 'badge' }] })

    expect(parseOverlayChatItem(textMessage({ id: CHANNEL }), CHANNEL).author.isOwner).toBe(true)
    expect(parseOverlayChatItem(textMessage({ is_moderator: true }), CHANNEL).author.isModerator).toBe(true)
    expect(parseOverlayChatItem(textMessage({ badges: [memberBadge] }), CHANNEL).author.isMember).toBe(true)
  })

  it('reads a Super Chat with its amount, and without a message', () => {
    const paid = node(YTNodes.LiveChatPaidMessage, {
      id: 'p1',
      message: {},
      timestamp: WRITTEN,
      purchase_amount: '$5.00',
      author: { id: 'UCdonor', name: 'Donor', badges: [] },
    })

    expect(parseOverlayChatItem(paid, CHANNEL)).toMatchObject({
      id: 'p1',
      author: { name: 'Donor' },
      message: '',
      amount: '$5.00',
    })
  })

  it('leaves out what the chat adds that is not a message', () => {
    expect(parseOverlayChatItem(node(YTNodes.LiveChatPlaceholderItem, { id: 'x' }), CHANNEL)).toBeNull()
  })
})

describe('chatAuthorName', () => {
  it('takes the name as a string or as a text', () => {
    expect(chatAuthorName({ name: 'Plain' })).toBe('Plain')
    expect(chatAuthorName({ name: { text: 'Texted' } })).toBe('Texted')
  })
})
