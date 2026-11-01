import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { showToast } from '../../helpers/utils'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import FtInput from '../../components/FtInput/FtInput.vue'
import FtPrompt from '../../components/FtPrompt/FtPrompt.vue'
import Sources from './Sources.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getCollectionsReady: true,
        getCollectionsGrabFailed: false,
        getCollectionSources: [],
        getCollectionShares: [],
      },
    }),
  }
})

vi.mock('../../helpers/utils', () => ({
  showToast: vi.fn(),
}))

const HACKERTUBE = { _id: 'hackertube', kind: 'hackertube', url: 'https://hackertube.org', name: 'HackerTube' }
const MEALTIME = { _id: 'lemmy:mealtimevideos@lemmy.cafe', kind: 'lemmy', url: 'https://lemmy.cafe/c/mealtimevideos', name: 'mealtimevideos@lemmy.cafe' }

/**
 * @param {{ _id: string }} source
 * @param {string} videoId
 */
function share(source, videoId) {
  return { _id: `${source._id}|${videoId}`, sourceId: source._id, videoId }
}

/**
 * The store's answer to a follow, as `followCollectionSourceByUrl` gives it
 *
 * @param {object | Error} answer
 */
function answerFollow(answer) {
  const dispatch = vi.fn(async (type, payload) => {
    // The field asks the store whether its text is a YouTube link, for its icon
    if (type === 'getYoutubeUrlInfo') { return { urlType: 'invalid_url' } }
    store.dispatched.push({ type, payload })
    if (type !== 'followCollectionSourceByUrl') { return undefined }
    if (answer instanceof Error) { throw answer }
    return answer
  })
  store.dispatch = dispatch
}

async function mountSources() {
  const router = createTestRouter([
    { path: '/sources', name: 'sources' },
    { path: '/sources/:sourceId', name: 'collectionSource' },
  ])
  await router.push('/sources')

  const wrapper = mountWithApp(Sources, { store, router, attachTo: document.body })
  await flushPromises()
  return wrapper
}

/**
 * Pastes the text given into the field and follows it, as Enter would
 *
 * @param {import('@vue/test-utils').VueWrapper} wrapper
 * @param {string} text
 */
async function paste(wrapper, text) {
  const input = wrapper.findComponent(FtInput)
  input.vm.$emit('input', text)
  input.vm.$emit('click', text)
  await flushPromises()
}

/** What the page dispatched to follow by address, apart from opening Collections */
const follows = () => store.dispatched.filter(({ type }) => type === 'followCollectionSourceByUrl')

enableAutoUnmount(afterEach)

const originalDispatch = store.dispatch

describe('the Sources page', () => {
  // Where a prompt opens, as in the app
  let app

  beforeEach(() => {
    app = document.createElement('div')
    app.classList.add('app')
    document.body.appendChild(app)
    store.dispatch = originalDispatch
    store.dispatched.length = 0
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionsGrabFailed', false)
    store.setGetter('getCollectionSources', [MEALTIME, HACKERTUBE])
    store.setGetter('getCollectionShares', [share(HACKERTUBE, 'aaaaaaaaaaa'), share(HACKERTUBE, 'bbbbbbbbbbb'), share(MEALTIME, 'aaaaaaaaaaa')])
    vi.mocked(showToast).mockClear()
  })

  afterEach(() => {
    app.remove()
  })

  it('lists every followed source by name, with what kind of place it is, its instance and how many videos, each opening its own page', async () => {
    const wrapper = await mountSources()

    const rows = wrapper.findAll('.source')
    expect(rows.map(row => row.find('.sourceName').text())).toEqual(['HackerTube', 'mealtimevideos@lemmy.cafe'])
    const about = row => row.findAll('.sourceAbout span').map(part => part.text())
    expect(about(rows[1])).toEqual(['Lemmy community', 'lemmy.cafe', '1 video'])
    expect(about(rows[0])).toEqual(['HackerTube', 'hackertube.org', '2 videos'])
    expect(rows[1].find('a').attributes('href')).toBe('/sources/lemmy:mealtimevideos@lemmy.cafe')
  })

  it('says when nothing is followed', async () => {
    store.setGetter('getCollectionSources', [])

    const wrapper = await mountSources()

    expect(wrapper.find('.message').text()).toBe('No source is followed.')
  })

  it('says how to write an address before anything is pasted', async () => {
    const wrapper = await mountSources()

    expect(wrapper.find('.followStatus').text()).toContain('!mealtimevideos@lemmy.cafe')
  })

  it('follows a pasted address, says so, and empties the field', async () => {
    answerFollow({ outcome: 'followed', source: { _id: 'lemmy:documentaries@lemmy.cafe', name: 'documentaries@lemmy.cafe' } })
    const wrapper = await mountSources()

    await paste(wrapper, 'https://lemmy.world/c/documentaries@lemmy.cafe')

    expect(follows()).toEqual([{ type: 'followCollectionSourceByUrl', payload: 'https://lemmy.world/c/documentaries@lemmy.cafe' }])
    expect(wrapper.find('.followStatus').text()).toBe('Following documentaries@lemmy.cafe.')
    expect(wrapper.find('.followStatus').classes()).not.toContain('refused')
    expect(wrapper.findComponent(FtInput).props('value')).toBe('')
  })

  it('says why an address was refused, and keeps it in the field', async () => {
    const cases = [
      [{ outcome: 'no-feed', source: { name: 'solarpunk@slrpnk.net' } }, 'solarpunk@slrpnk.net cannot be followed yet: its instance does not serve a feed Fjernsyn can read.'],
      [{ outcome: 'unreachable', source: { name: 'videos@down.example' } }, 'videos@down.example could not be reached. Check the address, or try again later.'],
      [{ outcome: 'unrecognised' }, 'Fjernsyn cannot follow this address yet. It follows HackerTube and Lemmy communities.'],
      [{ outcome: 'unavailable' }, 'The followed sources could not be read.'],
      [new Error('locked'), 'Something went wrong while following it.'],
    ]

    vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const [answer, said] of cases) {
      answerFollow(answer)
      const wrapper = await mountSources()

      await paste(wrapper, 'https://slrpnk.net/c/solarpunk')

      expect(wrapper.find('.followStatus').text(), said).toBe(said)
      expect(wrapper.find('.followStatus').classes()).toContain('refused')
      expect(wrapper.findComponent(FtInput).props('value')).toBe('https://slrpnk.net/c/solarpunk')
      wrapper.unmount()
    }
  })

  it('follows what is typed into the field on Enter, and puts the cursor back in the field', async () => {
    answerFollow({ outcome: 'no-feed', source: { name: 'solarpunk@slrpnk.net' } })
    const wrapper = await mountSources()
    const input = wrapper.find('.followInput input')

    await input.setValue('https://slrpnk.net/c/solarpunk')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(follows()).toEqual([{ type: 'followCollectionSourceByUrl', payload: 'https://slrpnk.net/c/solarpunk' }])
    expect(document.activeElement).toBe(input.element)
  })

  it('says a source is followed already', async () => {
    answerFollow({ outcome: 'followed-already', source: MEALTIME })
    const wrapper = await mountSources()

    await paste(wrapper, '!mealtimevideos@lemmy.cafe')

    expect(wrapper.find('.followStatus').text()).toBe('mealtimevideos@lemmy.cafe is followed already.')
  })

  it('follows nothing before the datastore is read, or after it could not be', async () => {
    for (const [getter, value] of [['getCollectionsReady', false], ['getCollectionsGrabFailed', true]]) {
      store.setGetter(getter, value)
      const wrapper = await mountSources()

      expect(wrapper.findComponent(FtInput).props('disabled'), getter).toBe(true)
      await paste(wrapper, 'https://lemmy.cafe/c/mealtimevideos')
      expect(follows(), getter).toEqual([])

      wrapper.unmount()
      store.setGetter(getter, getter === 'getCollectionsReady')
    }
  })

  it('opens Collections once the datastore is read, which follows the starter set on a first run and loads HackerTube\'s videos', async () => {
    store.setGetter('getCollectionsReady', false)
    const wrapper = await mountSources()
    const opens = () => store.dispatched.filter(({ type }) => type === 'openCollections')

    expect(opens()).toEqual([])

    store.setGetter('getCollectionsReady', true)
    await flushPromises()
    expect(opens()).toHaveLength(1)

    // Once only, whatever changes after
    store.setGetter('getCollectionSources', [HACKERTUBE])
    await flushPromises()
    expect(opens()).toHaveLength(1)
    wrapper.unmount()
  })

  it('names the source each unfollow button unfollows, for a screen reader and on hover', async () => {
    const wrapper = await mountSources()

    const button = wrapper.findAll('.source')[1].find('.unfollowButton')
    expect(button.attributes('aria-label')).toBe('Unfollow mealtimevideos@lemmy.cafe')
    expect(button.attributes('title')).toBe('Unfollow mealtimevideos@lemmy.cafe')
  })

  it('unfollows a source once the prompt is answered, and not when it is cancelled', async () => {
    const wrapper = await mountSources()

    await wrapper.findAll('.source')[1].find('.unfollowButton').trigger('click')
    const prompt = wrapper.findComponent(FtPrompt)
    expect(prompt.props('label')).toBe('Unfollow mealtimevideos@lemmy.cafe?')

    // What the prompt itself dispatches is not the page's
    const unfollowed = () => store.dispatched.filter(({ type }) => type === 'unfollowCollectionSource')

    prompt.vm.$emit('click', 'cancel')
    await flushPromises()
    expect(unfollowed()).toEqual([])
    expect(wrapper.findComponent(FtPrompt).exists()).toBe(false)

    await wrapper.findAll('.source')[1].find('.unfollowButton').trigger('click')
    wrapper.findComponent(FtPrompt).vm.$emit('click', 'unfollow')
    await flushPromises()

    expect(unfollowed()).toEqual([{ type: 'unfollowCollectionSource', payload: MEALTIME._id }])
    expect(showToast).toHaveBeenCalledWith('Unfollowed mealtimevideos@lemmy.cafe')
  })
})
