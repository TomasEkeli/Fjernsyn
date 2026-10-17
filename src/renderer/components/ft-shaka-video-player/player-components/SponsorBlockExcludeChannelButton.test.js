import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlayerIcons } from '../../../../constants'
import { SponsorBlockExcludeChannelButton } from './SponsorBlockExcludeChannelButton'

vi.mock('../../../i18n/index', async () => {
  const { createTestI18n } = await import('../../../testing/i18n')
  return { default: createTestI18n() }
})

// shaka's compiled UI calls its controls by minified names, so a fake of the
// controls would only fit one shaka build. What the button takes from shaka is
// an element base (its parent, an event manager, the localisation that says ON
// and OFF) and an icon; these stand in for those
vi.mock('shaka-player', () => {
  class Element {
    constructor(parent) {
      this.parent = parent
      this.isSubMenuOpened = false
      this.localization = { resolve: (id) => id }
      const unlisten = []
      this.eventManager = {
        listen(target, type, listener) {
          target.addEventListener(type, listener)
          unlisten.push(() => target.removeEventListener(type, listener))
        },
      }
      this.release = () => unlisten.splice(0).forEach(remove => remove())
    }
  }

  class Icon {
    constructor(parent, path) {
      this.path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.appendChild(this.path)
      parent.appendChild(svg)
      this.use(path)
    }

    use(path) {
      this.path.setAttribute('d', path)
    }
  }

  return { default: { ui: { Element, Icon } } }
})

const SKIPPED = 'SponsorBlock segments on this channel are skipped'
const NOT_SKIPPED = 'SponsorBlock segments on this channel are played, not skipped'

/** @type {SponsorBlockExcludeChannelButton[]} */
let built = []

/**
 * @param {boolean} excluded
 */
function build(excluded) {
  const parent = document.createElement('div')
  const events = new EventTarget()
  const element = new SponsorBlockExcludeChannelButton(excluded, events, parent, {})
  built.push(element)

  const button = parent.querySelector('button')
  const iconPath = () => button.querySelector('svg path')?.getAttribute('d')
  const state = () => button.querySelector('.shaka-current-selection-span').textContent

  return { events, button, iconPath, state }
}

beforeEach(() => {
  built = []
})

afterEach(() => {
  for (const element of built) {
    element.release()
  }
})

describe('the SponsorBlock exclude-channel button in the player controls', () => {
  it('says segments are skipped while they are, with a slashed dollar', () => {
    const { button, iconPath, state } = build(false)

    expect(button.ariaLabel).toBe(SKIPPED)
    expect(iconPath()).toBe(PlayerIcons.MONEY_OFF_DEFAULT)
    expect(state()).toBe('ON')
  })

  it('says segments are played while the channel is excluded, with a dollar', () => {
    const { button, iconPath, state } = build(true)

    expect(button.ariaLabel).toBe(NOT_SKIPPED)
    expect(iconPath()).toBe(PlayerIcons.PAID_FILLED)
    expect(state()).toBe('OFF')
  })

  it('only asks for the switch when clicked, leaving its own state to what the player says', () => {
    const { events, button } = build(false)
    const asked = vi.fn()
    events.addEventListener('toggleSponsorBlockExcludedChannel', asked)

    button.click()

    expect(asked).toHaveBeenCalledTimes(1)
    expect(button.ariaLabel).toBe(SKIPPED)
  })

  it('follows the list whoever changes it: this button, the one under the video, or the settings', () => {
    const { events, button, iconPath } = build(false)

    events.dispatchEvent(new CustomEvent('sponsorBlockExcludedChannelChanged', { detail: true }))

    expect(button.ariaLabel).toBe(NOT_SKIPPED)
    expect(iconPath()).toBe(PlayerIcons.PAID_FILLED)

    events.dispatchEvent(new CustomEvent('sponsorBlockExcludedChannelChanged', { detail: false }))

    expect(button.ariaLabel).toBe(SKIPPED)
    expect(iconPath()).toBe(PlayerIcons.MONEY_OFF_DEFAULT)
  })
})
