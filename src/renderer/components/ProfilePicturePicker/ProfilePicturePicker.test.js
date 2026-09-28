import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { mountWithApp } from '../../testing/mount'
import ProfilePicturePicker from './ProfilePicturePicker.vue'

// A small icon pack stands in for the real one, which the picker loads with a
// dynamic import, under the name it imports it by (see icons.js for the
// query). A factory that throws is called again on the next import,
// and one that returns is not, so the pack can be made to fail to load only
// until it has once loaded: the test of a failed load comes first.
const pack = vi.hoisted(() => ({ fail: false }))

vi.mock('@fortawesome/free-solid-svg-icons?picker', () => {
  if (pack.fail) {
    throw new Error('Loading chunk icons-solid failed')
  }

  const house = { prefix: 'fas', iconName: 'house', icon: [576, 512, [127968, 'home'], 'f015', 'M575.8 255.5c0 18-15 32.1-32 32.1z'] }
  const flask = { prefix: 'fas', iconName: 'flask', icon: [448, 512, [], 'f0c3', 'M288 0H160z'] }

  return { faHouse: house, faHome: house, faFlask: flask, prefix: 'fas' }
})

// helpers/utils, for its toast, imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

vi.mock('../../helpers/utils', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn(),
}))

const HOUSE = { kind: 'icon', name: 'house', width: 576, height: 512, path: 'M575.8 255.5c0 18-15 32.1-32 32.1z' }

/**
 * @param {import('../../helpers/profilePictures').ProfilePicture | null} [picture]
 */
function mountPicker(picture = null) {
  return mountWithApp(ProfilePicturePicker, { props: { picture } })
}

/**
 * @param {import('@vue/test-utils').VueWrapper} wrapper
 * @param {'letter' | 'symbol' | 'icon' | 'image'} kind
 */
function kindButton(wrapper, kind) {
  return wrapper.find(`.kinds [role="radio"][data-kind="${kind}"]`)
}

/**
 * @param {import('@vue/test-utils').VueWrapper} wrapper
 * @param {'letter' | 'symbol' | 'icon' | 'image'} kind
 */
async function chooseKind(wrapper, kind) {
  await kindButton(wrapper, kind).trigger('click')
  await flushPromises()
}

describe('the icon panel, when the icons cannot be loaded', () => {
  it('says so and emits nothing, and tries again the next time it opens', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    pack.fail = true
    const wrapper = mountPicker()

    await chooseKind(wrapper, 'icon')

    expect(logged).toHaveBeenCalledOnce()
    logged.mockRestore()
    expect(wrapper.text()).toContain('The icons could not be loaded')
    expect(wrapper.findAll('.iconCell')).toHaveLength(0)
    expect(wrapper.emitted('pick')).toBeUndefined()

    pack.fail = false
    await chooseKind(wrapper, 'symbol')
    await chooseKind(wrapper, 'icon')

    expect(wrapper.find('[aria-label="house"]').exists()).toBe(true)
    expect(wrapper.emitted('pick')).toBeUndefined()
  })
})

describe('the kind of picture', () => {
  it('starts at the current picture\'s kind, and at Letter when there is none', () => {
    expect(kindButton(mountPicker(), 'letter').attributes('aria-checked')).toBe('true')
    expect(kindButton(mountPicker({ kind: 'symbol', text: '★' }), 'symbol').attributes('aria-checked')).toBe('true')
    expect(kindButton(mountPicker({ kind: 'symbol', text: '★' }), 'letter').attributes('aria-checked')).toBe('false')
  })

  it('emits null for Letter', async () => {
    const wrapper = mountPicker({ kind: 'symbol', text: '★' })

    await chooseKind(wrapper, 'letter')

    expect(wrapper.emitted('pick')).toEqual([[null]])
  })

  it('is moved between with the arrow keys without choosing one, so passing Letter removes nothing', async () => {
    const wrapper = mountPicker({ kind: 'symbol', text: '★' })
    const kinds = wrapper.find('.kinds')

    await kinds.trigger('keydown', { key: 'ArrowLeft' })
    await kinds.trigger('keydown', { key: 'ArrowLeft' })
    await kinds.trigger('keydown', { key: 'End' })
    await kinds.trigger('keydown', { key: 'ArrowRight' })
    await kinds.trigger('keydown', { key: 'Home' })

    expect(wrapper.emitted('pick')).toBeUndefined()
    expect(kindButton(wrapper, 'symbol').attributes('aria-checked')).toBe('true')
    expect(kindButton(wrapper, 'letter').attributes('tabindex')).toBe('0')
    expect(kindButton(wrapper, 'symbol').attributes('tabindex')).toBe('-1')
  })

  it('emits nothing for another kind until something is chosen in it', async () => {
    const wrapper = mountPicker()

    await chooseKind(wrapper, 'symbol')
    await chooseKind(wrapper, 'icon')
    await chooseKind(wrapper, 'image')

    expect(wrapper.emitted('pick')).toBeUndefined()
  })
})

describe('a symbol', () => {
  it('is the first character typed or pasted, which the field is cut to', async () => {
    const wrapper = mountPicker()

    await chooseKind(wrapper, 'symbol')

    const field = wrapper.find('input[type="text"]')
    await field.setValue('  👨‍👩‍👧‍👦 family')

    expect(wrapper.emitted('pick')).toEqual([[{ kind: 'symbol', text: '👨‍👩‍👧‍👦' }]])
    expect(field.element.value).toBe('👨‍👩‍👧‍👦')
  })

  it('is shown in the field only while it is the picture, not after it was given up', async () => {
    const wrapper = mountPicker({ kind: 'symbol', text: '★' })

    expect(wrapper.find('input[type="text"]').element.value).toBe('★')

    await chooseKind(wrapper, 'letter')
    await wrapper.setProps({ picture: null })
    await chooseKind(wrapper, 'symbol')

    expect(wrapper.find('input[type="text"]').element.value).toBe('')
  })

  it('is not emitted for an empty field', async () => {
    const wrapper = mountPicker()

    await chooseKind(wrapper, 'symbol')
    await wrapper.find('input[type="text"]').setValue('   ')

    expect(wrapper.emitted('pick')).toBeUndefined()
  })

  it('is not emitted while an input method is still composing it, only once it is done', async () => {
    const wrapper = mountPicker()

    await chooseKind(wrapper, 'symbol')

    const field = wrapper.find('input[type="text"]')
    await field.trigger('compositionstart')
    await field.setValue('に')
    await field.setValue('にほ')

    expect(wrapper.emitted('pick')).toBeUndefined()

    await field.trigger('compositionend')

    expect(wrapper.emitted('pick')).toEqual([[{ kind: 'symbol', text: 'に' }]])
  })
})

describe('an icon', () => {
  it('is emitted with its name, size and path when picked', async () => {
    const wrapper = mountPicker()

    await chooseKind(wrapper, 'icon')
    await wrapper.find('[role="radio"][aria-label="house"]').trigger('click')

    expect(wrapper.emitted('pick')).toEqual([[HOUSE]])
  })

  it('is found by searching its aliases', async () => {
    const wrapper = mountPicker()

    await chooseKind(wrapper, 'icon')
    await wrapper.find('input[type="search"]').setValue('home')

    expect(wrapper.findAll('.iconGrid [role="radio"]').map(cell => cell.attributes('aria-label'))).toEqual(['house'])
  })

  it('says so when nothing matches the search', async () => {
    const wrapper = mountPicker()

    await chooseKind(wrapper, 'icon')
    await wrapper.find('input[type="search"]').setValue('science')

    expect(wrapper.text()).toContain('No icons match science')
  })

  it('shows the current icon checked, and in the tab order', async () => {
    const wrapper = mountPicker(HOUSE)
    await flushPromises()

    const house = wrapper.find('[role="radio"][aria-label="house"]')

    expect(house.attributes('aria-checked')).toBe('true')
    expect(house.attributes('tabindex')).toBe('0')
    expect(wrapper.find('[role="radio"][aria-label="flask"]').attributes('tabindex')).toBe('-1')
  })
})
