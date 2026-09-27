import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlatformError } from '../../platform/errors'
import { PLATFORM_LAYER_KEY } from '../../platform/vue'
import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import LayerComments from './LayerComments.vue'

const SETTINGS = vi.hoisted(() => ({
  getHideComments: false,
  getHideCommentPhotos: false,
  getCommentAutoLoadEnabled: false,
  getGeneralAutoLoadMorePaginatedItemsEnabled: false,
}))

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return { default: createFakeStore({ getters: { ...SETTINGS } }) }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

const HOST = 'framatube.org'
const UUID = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
const VIDEO_REF = { platform: 'peertube', host: HOST, videoId: UUID }
const AVATAR = 'https://framatube.org/lazy-static/avatars/alice.png'

let nextId = 1

/** A comment as the layer gives it */
function comment(overrides = {}) {
  const id = nextId++
  return {
    id,
    threadId: id,
    text: `Comment ${id}`,
    textKind: 'markdown',
    author: `Author ${id}`,
    authorAccount: `author${id}@${HOST}`,
    authorThumbnail: AVATAR,
    createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    isDeleted: false,
    replyCount: 0,
    ...overrides,
  }
}

const layer = {
  getComments: vi.fn(),
  getCommentReplies: vi.fn(),
}

/** The visibility callbacks the section registered, to scroll it into view */
let visibilityCallbacks

const observeVisibility = {
  mounted(element, { value }) {
    if (value) {
      visibilityCallbacks.push(() => value.callback(true))
    }
  },
  updated(element, { value, oldValue }) {
    if (value && value !== oldValue) {
      visibilityCallbacks.push(() => value.callback(true))
    }
  },
}

const openSections = []

beforeEach(() => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    store.state.fakeGetterValues[name] = value
  }
  layer.getComments.mockReset()
  layer.getCommentReplies.mockReset()
  visibilityCallbacks = []
  nextId = 1
})

afterEach(() => {
  for (const wrapper of openSections.splice(0)) {
    wrapper.unmount()
  }
})

async function mountComments(props = {}, { attachTo } = {}) {
  const wrapper = mount(LayerComments, {
    attachTo,
    props: { videoRef: VIDEO_REF, commentsEnabled: true, baseUrl: `https://${HOST}`, ...props },
    global: {
      plugins: [createTestI18n(), store],
      provide: { [PLATFORM_LAYER_KEY]: layer },
      directives: { 'observe-visibility': observeVisibility },
    },
  })
  openSections.push(wrapper)
  await flushPromises()
  return wrapper
}

function byText(wrapper, selector, text) {
  return wrapper.findAll(selector).find(element => element.text().includes(text))
}

async function clickText(wrapper, text) {
  const target = byText(wrapper, '[role="button"], button', text)
  expect(target, `nothing to click that says "${text}"`).toBeDefined()
  await target.trigger('click')
  await flushPromises()
}

async function showComments(wrapper) {
  await clickText(wrapper, 'Click to View Comments')
}

function commentTexts(wrapper) {
  return wrapper.findAll('.commentText').map(element => element.text())
}

describe('LayerComments, loading', () => {
  it('asks for nothing until the viewer asks for the comments', async () => {
    const wrapper = await mountComments()

    expect(layer.getComments).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Click to View Comments')
  })

  it('loads the first page of threads when asked, from the video\'s ref', async () => {
    layer.getComments.mockResolvedValue({ items: [comment(), comment()], cursor: null })
    const wrapper = await mountComments()

    await showComments(wrapper)

    expect(layer.getComments).toHaveBeenCalledWith(VIDEO_REF, { cursor: null })
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Comment 2'])
  })

  it('loads itself on coming into view when comments load automatically', async () => {
    store.setGetter('getCommentAutoLoadEnabled', true)
    layer.getComments.mockResolvedValue({ items: [comment()], cursor: null })
    const wrapper = await mountComments()
    expect(wrapper.text()).not.toContain('Click to View Comments')

    visibilityCallbacks.at(-1)()
    await flushPromises()

    expect(layer.getComments).toHaveBeenCalledTimes(1)
    expect(commentTexts(wrapper)).toEqual(['Comment 1'])
  })

  it('shows each thread with its author, avatar and how long ago it was written', async () => {
    layer.getComments.mockResolvedValue({ items: [comment({ author: 'Alice', authorAccount: `alice@${HOST}` })], cursor: null })
    const wrapper = await mountComments()

    await showComments(wrapper)

    expect(wrapper.find('.commentAuthor').text()).toBe('Alice')
    expect(wrapper.find('.commentAuthor').attributes('title')).toBe(`alice@${HOST}`)
    expect(wrapper.find(`img.commentThumbnail[src="${AVATAR}"]`).exists()).toBe(true)
    expect(wrapper.find('.commentDate').text()).toBe('3 days ago')
  })

  it.each([
    [0],
    [null],
    [Number.NaN],
    [-1],
  ])('shows no date for a comment without one (createdAt %s)', async (createdAt) => {
    layer.getComments.mockResolvedValue({ items: [comment({ createdAt })], cursor: null })
    const wrapper = await mountComments()

    await showComments(wrapper)

    expect(wrapper.find('.commentDate').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('years ago')
  })

  it('never links the author, whose handle is an account and not a channel', async () => {
    layer.getComments.mockResolvedValue({ items: [comment()], cursor: null })
    const wrapper = await mountComments()

    await showComments(wrapper)

    expect(wrapper.find('.comment a').exists()).toBe(false)
  })

  it('hides the avatars when comment photos are hidden', async () => {
    store.setGetter('getHideCommentPhotos', true)
    layer.getComments.mockResolvedValue({ items: [comment({ author: 'Alice' })], cursor: null })
    const wrapper = await mountComments()

    await showComments(wrapper)

    expect(wrapper.find('img.commentThumbnail').exists()).toBe(false)
    expect(wrapper.find('.commentThumbnailHidden').text()).toBe('A')
  })

  it('says so when there are no comments', async () => {
    layer.getComments.mockResolvedValue({ items: [], cursor: null })
    const wrapper = await mountComments()

    await showComments(wrapper)

    expect(wrapper.text()).toContain('There are no comments available for this video')
  })
})

describe('LayerComments, the text', () => {
  it('renders a PeerTube comment from its Markdown, with raw HTML escaped', async () => {
    layer.getComments.mockResolvedValue({
      items: [comment({ text: 'So *good*, see [the site](https://blender.org) <img src=x onerror=steal()>' })],
      cursor: null,
    })
    const wrapper = await mountComments()

    await showComments(wrapper)

    const text = wrapper.find('.commentText')
    expect(text.find('em').text()).toBe('good')
    expect(text.find('a').attributes('href')).toBe('https://blender.org/')
    expect(text.find('img').exists()).toBe(false)
    expect(text.text()).toContain('<img src=x onerror=steal()>')
  })

  it('renders a federated comment\'s HTML, sanitised, with no script, handler or remote image surviving', async () => {
    const html = '<p>Hi <span class="h-card"><a href="https://mastodon.social/@bob" class="u-url mention" onclick="steal()">@<span>bob</span></a></span>' +
      ' <img src="https://tracker.example/pixel.png" alt="wave"><script>steal()</script>' +
      ' <a href="javascript:steal()">bad</a> <b style="position:fixed">bold</b></p><p>Second</p>'
    layer.getComments.mockResolvedValue({ items: [comment({ text: html, textKind: 'html' })], cursor: null })
    const wrapper = await mountComments()

    await showComments(wrapper)

    const text = wrapper.find('.commentText')
    const markup = text.html()
    expect(text.findAll('p')).toHaveLength(2)
    expect(text.find('img').exists()).toBe(false)
    expect(markup).not.toContain('tracker.example')
    expect(text.find('script').exists()).toBe(false)
    expect(markup).not.toContain('onclick')
    expect(markup).not.toContain('javascript:')
    expect(markup).not.toContain('style=')
    expect(text.find('a').attributes('href')).toBe('https://mastodon.social/@bob')
    expect(text.findAll('a')).toHaveLength(1)
    expect(text.text()).toContain('@bob')
    expect(text.text()).toContain('wave')
    expect(text.text()).toContain('bad')
    expect(text.find('b').text()).toBe('bold')
  })

  it('hands a click inside a federated comment\'s link to the link, as the app\'s external link handler reads it', async () => {
    const html = '<p><a href="https://mastodon.social/@bob">@<span>bob</span></a></p>'
    layer.getComments.mockResolvedValue({ items: [comment({ text: html, textKind: 'html' })], cursor: null })
    const wrapper = await mountComments({}, { attachTo: document.body })
    await showComments(wrapper)

    // App.vue listens on the document, and opens a link externally only when
    // the click's target is the link
    const targets = []
    const listener = (event) => {
      targets.push(event.target)
      event.preventDefault()
    }
    document.addEventListener('click', listener)

    try {
      await wrapper.find('.commentText a span').trigger('click')
    } finally {
      document.removeEventListener('click', listener)
    }

    expect(targets).toEqual([wrapper.find('.commentText a').element])
  })

  it('shows a deleted comment as deleted, without an author', async () => {
    layer.getComments.mockResolvedValue({
      items: [comment({ isDeleted: true, text: '', author: '', authorAccount: '', authorThumbnail: '' })],
      cursor: null,
    })
    const wrapper = await mountComments()

    await showComments(wrapper)

    expect(wrapper.find('.commentText').text()).toBe('This comment has been deleted')
    expect(wrapper.find('.commentAuthor').exists()).toBe(false)
    expect(wrapper.find('img.commentThumbnail').exists()).toBe(false)
  })
})

describe('LayerComments, more threads', () => {
  it('loads the next page with the cursor the last one gave, and stops at the end', async () => {
    layer.getComments
      .mockResolvedValueOnce({ items: [comment(), comment()], cursor: 20 })
      .mockResolvedValueOnce({ items: [comment()], cursor: null })
    const wrapper = await mountComments()
    await showComments(wrapper)

    await clickText(wrapper, 'Load More Comments')

    expect(layer.getComments).toHaveBeenLastCalledWith(VIDEO_REF, { cursor: 20 })
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Comment 2', 'Comment 3'])
    expect(wrapper.text()).not.toContain('Load More Comments')
  })

  it('loads more on reaching the end when paginated lists load automatically', async () => {
    store.setGetter('getCommentAutoLoadEnabled', true)
    store.setGetter('getGeneralAutoLoadMorePaginatedItemsEnabled', true)
    layer.getComments
      .mockResolvedValueOnce({ items: [comment()], cursor: 20 })
      .mockResolvedValueOnce({ items: [comment()], cursor: null })
    const wrapper = await mountComments()

    visibilityCallbacks.at(-1)()
    await flushPromises()
    visibilityCallbacks.at(-1)()
    await flushPromises()

    expect(layer.getComments).toHaveBeenCalledTimes(2)
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Comment 2'])
  })
})

describe('LayerComments, replies', () => {
  it('loads a thread\'s replies only when asked', async () => {
    const thread = comment({ replyCount: 2 })
    layer.getComments.mockResolvedValue({ items: [thread], cursor: null })
    layer.getCommentReplies.mockResolvedValue({ items: [comment({ text: 'Reply A' }), comment({ text: 'Reply B' })], cursor: null })
    const wrapper = await mountComments()
    await showComments(wrapper)

    expect(layer.getCommentReplies).not.toHaveBeenCalled()
    await clickText(wrapper, 'View 2 replies')

    expect(layer.getCommentReplies).toHaveBeenCalledWith(VIDEO_REF, thread, { cursor: null })
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Reply A', 'Reply B'])
  })

  it('pages through the replies', async () => {
    const thread = comment({ replyCount: 3 })
    layer.getComments.mockResolvedValue({ items: [thread], cursor: null })
    layer.getCommentReplies
      .mockResolvedValueOnce({ items: [comment({ text: 'Reply A' }), comment({ text: 'Reply B' })], cursor: 2 })
      .mockResolvedValueOnce({ items: [comment({ text: 'Reply C' })], cursor: null })
    const wrapper = await mountComments()
    await showComments(wrapper)
    await clickText(wrapper, 'View 3 replies')

    await clickText(wrapper, 'Show more replies')

    expect(layer.getCommentReplies).toHaveBeenLastCalledWith(VIDEO_REF, thread, { cursor: 2 })
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Reply A', 'Reply B', 'Reply C'])
    expect(wrapper.text()).not.toContain('Show more replies')
  })

  it('loads a reply\'s own replies on demand, the same way', async () => {
    const thread = comment({ replyCount: 2 })
    const reply = comment({ text: 'Reply A', replyCount: 1 })
    layer.getComments.mockResolvedValue({ items: [thread], cursor: null })
    layer.getCommentReplies
      .mockResolvedValueOnce({ items: [reply], cursor: null })
      .mockResolvedValueOnce({ items: [comment({ text: 'Reply to A' })], cursor: null })
    const wrapper = await mountComments()
    await showComments(wrapper)
    await clickText(wrapper, 'View 2 replies')

    await clickText(wrapper, 'View 1 reply')

    expect(layer.getCommentReplies).toHaveBeenLastCalledWith(VIDEO_REF, reply, { cursor: null })
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Reply A', 'Reply to A'])
  })

  it('hides and shows loaded replies again without asking again', async () => {
    layer.getComments.mockResolvedValue({ items: [comment({ replyCount: 1 })], cursor: null })
    layer.getCommentReplies.mockResolvedValue({ items: [comment({ text: 'Reply A' })], cursor: null })
    const wrapper = await mountComments()
    await showComments(wrapper)
    await clickText(wrapper, 'View 1 reply')

    await clickText(wrapper, 'Hide reply')
    expect(commentTexts(wrapper)).toEqual(['Comment 1'])

    await clickText(wrapper, 'View 1 reply')
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Reply A'])
    expect(layer.getCommentReplies).toHaveBeenCalledTimes(1)
  })

  it('offers the replies of a deleted comment too', async () => {
    layer.getComments.mockResolvedValue({ items: [comment({ isDeleted: true, text: '', author: '', replyCount: 1 })], cursor: null })
    layer.getCommentReplies.mockResolvedValue({ items: [comment({ text: 'Reply A' })], cursor: null })
    const wrapper = await mountComments()
    await showComments(wrapper)

    await clickText(wrapper, 'View 1 reply')

    expect(commentTexts(wrapper)).toEqual(['This comment has been deleted', 'Reply A'])
  })

  it('says when the replies could not be loaded, and tries again', async () => {
    layer.getComments.mockResolvedValue({ items: [comment({ replyCount: 1 })], cursor: null })
    layer.getCommentReplies
      .mockRejectedValueOnce(new PlatformError('unavailable', 'down', { host: HOST }))
      .mockResolvedValueOnce({ items: [comment({ text: 'Reply A' })], cursor: null })
    const wrapper = await mountComments()
    await showComments(wrapper)

    await clickText(wrapper, 'View 1 reply')
    expect(wrapper.text()).toContain('The replies could not be loaded.')

    await clickText(wrapper, 'Try Again')
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Reply A'])
    expect(wrapper.text()).not.toContain('The replies could not be loaded.')
  })
})

describe('LayerComments, when there are none to show', () => {
  it('says comments are turned off for the video, and asks for nothing', async () => {
    const wrapper = await mountComments({ commentsEnabled: false })

    expect(wrapper.text()).toContain('Comments are turned off')
    expect(wrapper.text()).not.toContain('Click to View Comments')
    expect(visibilityCallbacks).toEqual([])
    expect(layer.getComments).not.toHaveBeenCalled()
  })

  it('is not there when comments are hidden, and asks for nothing', async () => {
    store.setGetter('getHideComments', true)
    store.setGetter('getCommentAutoLoadEnabled', true)
    const wrapper = await mountComments()

    expect(wrapper.text()).toBe('')
    expect(visibilityCallbacks).toEqual([])
    expect(layer.getComments).not.toHaveBeenCalled()
  })

  it('says when the comments could not be loaded, and tries again', async () => {
    layer.getComments
      .mockRejectedValueOnce(new PlatformError('unavailable', 'down', { host: HOST }))
      .mockResolvedValueOnce({ items: [comment()], cursor: null })
    const wrapper = await mountComments()

    await showComments(wrapper)
    expect(wrapper.text()).toContain('The comments could not be loaded.')

    await clickText(wrapper, 'Try Again')
    expect(layer.getComments).toHaveBeenCalledTimes(2)
    expect(commentTexts(wrapper)).toEqual(['Comment 1'])
    expect(wrapper.text()).not.toContain('could not be loaded')
  })

  it('keeps the threads it has when the next page fails, and tries that page again', async () => {
    layer.getComments
      .mockResolvedValueOnce({ items: [comment()], cursor: 20 })
      .mockRejectedValueOnce(new PlatformError('rateLimited', 'slow down', { host: HOST, retryAfterMs: 1000 }))
      .mockResolvedValueOnce({ items: [comment()], cursor: null })
    const wrapper = await mountComments()
    await showComments(wrapper)

    await clickText(wrapper, 'Load More Comments')
    expect(commentTexts(wrapper)).toEqual(['Comment 1'])
    expect(wrapper.text()).toContain('The comments could not be loaded.')

    await clickText(wrapper, 'Try Again')
    expect(layer.getComments).toHaveBeenLastCalledWith(VIDEO_REF, { cursor: 20 })
    expect(commentTexts(wrapper)).toEqual(['Comment 1', 'Comment 2'])
  })
})
