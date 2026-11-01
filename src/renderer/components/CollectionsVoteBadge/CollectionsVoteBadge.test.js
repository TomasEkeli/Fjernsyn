import { afterEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import CollectionsVoteBadge from './CollectionsVoteBadge.vue'

const SOURCES = {
  hackertube: { _id: 'hackertube', kind: 'hackertube', name: 'HackerTube' },
  'lemmy:talks@programming.dev': { _id: 'lemmy:talks@programming.dev', kind: 'lemmy', name: 'talks@programming.dev' },
}

const VIDEO_ID = 'aKLntZcp27M'

const SHARES = {
  [`hackertube|${VIDEO_ID}`]: {
    _id: `hackertube|${VIDEO_ID}`,
    sourceId: 'hackertube',
    videoId: VIDEO_ID,
    votes: 11.5,
    why: '<b>HN\'s</b> perennial answer',
    sharedAt: Date.UTC(2026, 0, 1),
    discussionUrl: 'https://news.ycombinator.com/item?id=123',
  },
  [`lemmy:talks@programming.dev|${VIDEO_ID}`]: {
    _id: `lemmy:talks@programming.dev|${VIDEO_ID}`,
    sourceId: 'lemmy:talks@programming.dev',
    videoId: VIDEO_ID,
    votes: 6,
    why: 'Watch the whole thing',
    sharedAt: new Date(2026, 2, 3, 12).getTime(),
    discussionUrl: 'https://programming.dev/post/1',
  },
}

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getCollectionSource: id => SOURCES[id],
        getCollectionShare: id => SHARES[id],
      },
    }),
  }
})

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

/**
 * @param {Partial<import('../../helpers/collections/shares').CollectionValues>} collection
 */
function wallVideo(collection) {
  return {
    type: 'video',
    videoId: VIDEO_ID,
    title: 'Simple Made Easy',
    author: 'InfoQ',
    lengthSeconds: '',
    collection: { votes: null, sharedAt: null, sourceIds: [], ...collection },
  }
}

const SHARED_TWICE = wallVideo({ votes: 17.5, sourceIds: ['hackertube', 'lemmy:talks@programming.dev'] })

/**
 * @param {object} video
 * @param {string | null} [sourceId]
 */
function mountBadge(video, sourceId = null) {
  const wrapper = mountWithApp(CollectionsVoteBadge, { store, props: { video, sourceId } })
  mounted.push(wrapper)
  return wrapper
}

let mounted = []

afterEach(() => {
  for (const wrapper of mounted) { wrapper.unmount() }
  mounted = []
})

describe('the vote badge', () => {
  it('shows the votes summed, half votes kept', () => {
    const wrapper = mountBadge(SHARED_TWICE)

    expect(wrapper.find('button.votes').text()).toBe('▲ 17.5')
    expect(wrapper.find('button.votes').attributes('aria-label')).toBe('17.5 upvotes')
  })

  it('shows nothing for a video no shown source voted on', () => {
    const wrapper = mountBadge(wallVideo({ votes: null, sourceIds: ['hackertube'] }))

    expect(wrapper.find('.collectionsVoteBadge').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('shows zero votes as zero', () => {
    expect(mountBadge(wallVideo({ votes: 0, sourceIds: ['hackertube'] })).find('button.votes').text()).toBe('▲ 0')
  })

  it('is described, for a screen reader, by what hovering it shows', () => {
    const wrapper = mountBadge(SHARED_TWICE)

    const popover = wrapper.find('.popover')
    expect(wrapper.find('button.votes').attributes('aria-describedby')).toBe(popover.attributes('id'))
  })

  it('is put away by Escape until the pointer leaves it', async () => {
    const wrapper = mountBadge(SHARED_TWICE)
    const badge = wrapper.find('.collectionsVoteBadge')

    await badge.trigger('keydown', { key: 'Escape' })
    expect(badge.classes()).toContain('dismissed')

    await badge.trigger('mouseleave')
    expect(badge.classes()).not.toContain('dismissed')
  })

  it('is put away by Escape until the focus leaves it', async () => {
    const wrapper = mountBadge(SHARED_TWICE)
    const badge = wrapper.find('.collectionsVoteBadge')

    await badge.trigger('keydown', { key: 'Escape' })
    await badge.trigger('focusout', { relatedTarget: null })
    expect(badge.classes()).not.toContain('dismissed')
  })
})

describe('hovering it on Collections', () => {
  it('lists the sources that shared the video, each with its own votes, and nothing else', () => {
    const wrapper = mountBadge(SHARED_TWICE)
    const popover = wrapper.find('.popover')

    expect(popover.attributes('role')).toBe('tooltip')
    expect(popover.findAll('.source').map(row => [row.find('.sourceName').text(), row.find('.sourceVotes').text()])).toEqual([
      ['HackerTube', '▲ 11.5'],
      ['talks@programming.dev', '▲ 6'],
    ])
    expect(popover.find('.why').exists()).toBe(false)
    expect(popover.find('.shareDate').exists()).toBe(false)
    expect(popover.find('a').exists()).toBe(false)
    expect(popover.text()).not.toContain('perennial')
  })

  it('lists only the sources shown', () => {
    const wrapper = mountBadge(wallVideo({ votes: 6, sourceIds: ['lemmy:talks@programming.dev'] }))

    expect(wrapper.findAll('.sourceName').map(name => name.text())).toEqual(['talks@programming.dev'])
  })
})

describe('hovering it on a source\'s page', () => {
  it('shows that share\'s why, date, votes and the discussion, and no other source', () => {
    const wrapper = mountBadge(wallVideo({ votes: 6, sourceIds: ['lemmy:talks@programming.dev'] }), 'lemmy:talks@programming.dev')
    const popover = wrapper.find('.popover')

    expect(wrapper.find('button.votes').text()).toBe('▲ 6')
    expect(popover.attributes('role')).toBeUndefined()
    expect(popover.find('.why').text()).toBe('Watch the whole thing')
    expect(popover.find('.shareVotes').text()).toBe('▲ 6')
    expect(popover.find('.shareDate').text()).toBe('Shared Mar 3, 2026')
    expect(popover.find('.sources').exists()).toBe(false)
    expect(popover.text()).not.toContain('HackerTube')
  })

  it('links the discussion as a plain external link, its text alone, which the app opens in the browser', () => {
    const wrapper = mountBadge(wallVideo({ votes: 6, sourceIds: ['lemmy:talks@programming.dev'] }), 'lemmy:talks@programming.dev')
    const link = wrapper.find('a.discussion')

    expect(link.attributes('href')).toBe('https://programming.dev/post/1')
    expect(link.element.children).toHaveLength(0)
    expect(link.text()).toBe('Open the discussion')
  })

  it('dates a HackerTube share by its year alone, and shows its why as text, never as markup', () => {
    const wrapper = mountBadge(wallVideo({ votes: 11.5, sourceIds: ['hackertube'] }), 'hackertube')
    const why = wrapper.find('.why')

    expect(wrapper.find('.shareDate').text()).toBe('Shared 2026')
    expect(why.text()).toBe('<b>HN\'s</b> perennial answer')
    expect(why.find('b').exists()).toBe(false)
  })

  it('links no discussion whose address is not a web address', () => {
    const kept = SHARES[`hackertube|${VIDEO_ID}`]
    SHARES[`hackertube|${VIDEO_ID}`] = { ...kept, discussionUrl: 'javascript:alert(1)' }

    try {
      const wrapper = mountBadge(wallVideo({ votes: 11.5, sourceIds: ['hackertube'] }), 'hackertube')

      expect(wrapper.find('a').exists()).toBe(false)
      expect(wrapper.find('.why').exists()).toBe(true)
    } finally {
      SHARES[`hackertube|${VIDEO_ID}`] = kept
    }
  })
})
