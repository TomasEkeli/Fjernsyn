import { afterEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import CommunitiesVoteBadge from './CommunitiesVoteBadge.vue'

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
        getCommunitySource: id => SOURCES[id],
        getCommunityShare: id => SHARES[id],
      },
    }),
  }
})

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

/**
 * @param {Partial<import('../../helpers/communities/shares').CommunityValues>} community
 */
function wallVideo(community) {
  return {
    type: 'video',
    videoId: VIDEO_ID,
    title: 'Simple Made Easy',
    author: 'InfoQ',
    lengthSeconds: '',
    community: { votes: null, sharedAt: null, sourceIds: [], ...community },
  }
}

const SHARED_TWICE = wallVideo({ votes: 17.5, sourceIds: ['hackertube', 'lemmy:talks@programming.dev'] })

/**
 * @param {object} video
 * @param {string | null} [sourceId]
 */
function mountBadge(video, sourceId = null) {
  const wrapper = mountWithApp(CommunitiesVoteBadge, { store, props: { video, sourceId }, attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

/**
 * Mounts the badge and hovers it, which renders what hovering shows
 *
 * @param {object} video
 * @param {string | null} [sourceId]
 */
async function mountOpened(video, sourceId = null) {
  const wrapper = mountBadge(video, sourceId)
  await wrapper.find('.communitiesVoteBadge').trigger('pointerenter')
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

    expect(wrapper.find('.communitiesVoteBadge').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('shows zero votes as zero', () => {
    expect(mountBadge(wallVideo({ votes: 0, sourceIds: ['hackertube'] })).find('button.votes').text()).toBe('▲ 0')
  })

  it('hides its arrow from a screen reader', () => {
    const arrow = mountBadge(SHARED_TWICE).find('button.votes [aria-hidden="true"]')

    expect(arrow.text()).toBe('▲')
  })

  it('is described, for a screen reader, by what hovering it shows', () => {
    const wrapper = mountBadge(SHARED_TWICE)

    const popover = wrapper.find('.popover')
    expect(wrapper.find('button.votes').attributes('aria-describedby')).toBe(popover.attributes('id'))
  })

  it('renders what hovering it shows only once hovered or focused, the popover itself always there', async () => {
    const wrapper = mountBadge(SHARED_TWICE)
    const badge = wrapper.find('.communitiesVoteBadge')

    expect(wrapper.find('.popover').exists()).toBe(true)
    expect(wrapper.find('.popover').element.children).toHaveLength(0)

    await badge.trigger('focusin')
    expect(wrapper.findAll('.source')).toHaveLength(2)

    await badge.trigger('mouseleave')
    await badge.trigger('focusout', { relatedTarget: null })
    expect(wrapper.findAll('.source')).toHaveLength(2)
  })

  it('renders what hovering it shows on the pointer entering it', async () => {
    const wrapper = mountBadge(SHARED_TWICE)

    await wrapper.find('.communitiesVoteBadge').trigger('pointerenter')
    expect(wrapper.findAll('.source')).toHaveLength(2)
  })

  it('is put away by Escape until the pointer leaves it', async () => {
    const wrapper = mountBadge(SHARED_TWICE)
    const badge = wrapper.find('.communitiesVoteBadge')

    await badge.trigger('keydown', { key: 'Escape' })
    expect(badge.classes()).toContain('dismissed')

    await badge.trigger('mouseleave')
    expect(badge.classes()).not.toContain('dismissed')
  })

  it('is put away by Escape until the focus leaves it', async () => {
    const wrapper = mountBadge(SHARED_TWICE)
    const badge = wrapper.find('.communitiesVoteBadge')

    await badge.trigger('keydown', { key: 'Escape' })
    await badge.trigger('focusout', { relatedTarget: null })
    expect(badge.classes()).not.toContain('dismissed')
  })

  it('says nothing of being expanded on Communities, where it is a tooltip', async () => {
    const wrapper = await mountOpened(SHARED_TWICE)

    expect(wrapper.find('button.votes').attributes('aria-expanded')).toBeUndefined()
  })
})

describe('hovering it on Communities', () => {
  it('lists the sources that shared the video, each with its own votes, and nothing else', async () => {
    const wrapper = await mountOpened(SHARED_TWICE)
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
    expect(popover.findAll('.sourceVotes [aria-hidden="true"]').map(arrow => arrow.text())).toEqual(['▲', '▲'])
  })

  it('lists only the sources shown', async () => {
    const wrapper = await mountOpened(wallVideo({ votes: 6, sourceIds: ['lemmy:talks@programming.dev'] }))

    expect(wrapper.findAll('.sourceName').map(name => name.text())).toEqual(['talks@programming.dev'])
  })
})

describe('hovering it on a source\'s page', () => {
  it('shows that share\'s why, date, votes and the discussion, and no other source', async () => {
    const wrapper = await mountOpened(wallVideo({ votes: 6, sourceIds: ['lemmy:talks@programming.dev'] }), 'lemmy:talks@programming.dev')
    const popover = wrapper.find('.popover')

    expect(wrapper.find('button.votes').text()).toBe('▲ 6')
    expect(popover.attributes('role')).toBeUndefined()
    expect(popover.find('.why').text()).toBe('Watch the whole thing')
    expect(popover.find('.shareVotes').text()).toBe('▲ 6')
    expect(popover.find('.shareDate').text()).toBe('Shared Mar 3, 2026')
    expect(popover.find('.sources').exists()).toBe(false)
    expect(popover.text()).not.toContain('HackerTube')
  })

  it('links the discussion as a plain external link, its text alone, which the app opens in the browser', async () => {
    const wrapper = await mountOpened(wallVideo({ votes: 6, sourceIds: ['lemmy:talks@programming.dev'] }), 'lemmy:talks@programming.dev')
    const link = wrapper.find('a.discussion')

    expect(link.attributes('href')).toBe('https://programming.dev/post/1')
    expect(link.element.children).toHaveLength(0)
    expect(link.text()).toBe('Open the discussion')
  })

  it('dates a HackerTube share by its year alone, and shows its why as text, never as markup', async () => {
    const wrapper = await mountOpened(wallVideo({ votes: 11.5, sourceIds: ['hackertube'] }), 'hackertube')
    const why = wrapper.find('.why')

    expect(wrapper.find('.shareDate').text()).toBe('Shared 2026')
    expect(why.text()).toBe('<b>HN\'s</b> perennial answer')
    expect(why.find('b').exists()).toBe(false)
  })

  it('links no discussion whose address is not a web address', async () => {
    const kept = SHARES[`hackertube|${VIDEO_ID}`]
    SHARES[`hackertube|${VIDEO_ID}`] = { ...kept, discussionUrl: 'javascript:alert(1)' }

    try {
      const wrapper = await mountOpened(wallVideo({ votes: 11.5, sourceIds: ['hackertube'] }), 'hackertube')

      expect(wrapper.find('a').exists()).toBe(false)
      expect(wrapper.find('.why').exists()).toBe(true)
    } finally {
      SHARES[`hackertube|${VIDEO_ID}`] = kept
    }
  })

  it('says whether what hovering it shows is shown', async () => {
    const wrapper = mountBadge(wallVideo({ votes: 6, sourceIds: ['lemmy:talks@programming.dev'] }), 'lemmy:talks@programming.dev')
    const badge = wrapper.find('.communitiesVoteBadge')
    const button = wrapper.find('button.votes')

    expect(button.attributes('aria-expanded')).toBe('false')

    await badge.trigger('pointerenter')
    expect(button.attributes('aria-expanded')).toBe('true')

    await badge.trigger('keydown', { key: 'Escape' })
    expect(button.attributes('aria-expanded')).toBe('false')

    await badge.trigger('mouseleave')
    await badge.trigger('focusin')
    expect(button.attributes('aria-expanded')).toBe('true')

    await badge.trigger('focusout', { relatedTarget: null })
    expect(button.attributes('aria-expanded')).toBe('false')
  })

  it('takes the focus back to the badge on Escape from the discussion link, so that it is not lost with the popover', async () => {
    const wrapper = await mountOpened(wallVideo({ votes: 6, sourceIds: ['lemmy:talks@programming.dev'] }), 'lemmy:talks@programming.dev')
    const link = wrapper.find('a.discussion')

    link.element.focus()
    await link.trigger('keydown', { key: 'Escape' })

    expect(document.activeElement).toBe(wrapper.find('button.votes').element)
    expect(wrapper.find('.communitiesVoteBadge').classes()).toContain('dismissed')
  })
})
