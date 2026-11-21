import shaka from 'shaka-player'

import i18n from '../../../i18n/index'
import { PlayerIcons } from '../../../../constants'

/**
 * Pins the player's controls so they stay on screen instead of fading once the
 * mouse goes still.
 *
 * The button only asks for the change. The pinned state lives in the settings
 * store, and flipping it reconfigures shaka, which rebuilds the controls, so a
 * fresh button is created with the new state rather than this one updating.
 */
export class PinControlsButton extends shaka.ui.Element {
  /**
   * @param {boolean} pinned
   * @param {EventTarget} events
   * @param {HTMLElement} parent
   * @param {shaka.ui.Controls} controls
   */
  constructor(pinned, events, parent, controls) {
    super(parent, controls)

    /** @private */
    this.button_ = document.createElement('button')
    this.button_.classList.add('pin-controls-button', 'shaka-tooltip')

    /** @private */
    this.icon_ = new shaka.ui.Icon(this.button_, PlayerIcons.KEEP_DEFAULT)

    const label = document.createElement('label')
    label.classList.add(
      'shaka-overflow-button-label',
      'shaka-overflow-menu-only',
      'shaka-simple-overflow-button-label-inline'
    )

    /** @private */
    this.nameSpan_ = document.createElement('span')
    label.appendChild(this.nameSpan_)

    /** @private */
    this.currentState_ = document.createElement('span')
    this.currentState_.classList.add('shaka-current-selection-span')
    label.appendChild(this.currentState_)

    this.button_.appendChild(label)

    this.parent.appendChild(this.button_)

    /** @private */
    this.pinned_ = pinned

    // listeners

    this.eventManager.listen(this.button_, 'click', () => {
      events.dispatchEvent(new CustomEvent('setPinControls', {
        detail: !this.pinned_
      }))
    })

    this.eventManager.listen(events, 'localeChanged', () => {
      this.updateLocalisedStrings_()
    })

    this.updateLocalisedStrings_()
  }

  /** @private */
  updateLocalisedStrings_() {
    this.icon_.use(this.pinned_ ? PlayerIcons.KEEP_FILLED : PlayerIcons.KEEP_DEFAULT)

    this.nameSpan_.textContent = i18n.global.t('Video.Player.Pin Controls')

    this.currentState_.textContent = this.localization.resolve(this.pinned_ ? 'ON' : 'OFF')

    this.button_.ariaLabel = this.pinned_
      ? i18n.global.t('Video.Player.Unpin Controls')
      : i18n.global.t('Video.Player.Pin Controls')

    this.button_.ariaPressed = this.pinned_ ? 'true' : 'false'
  }

  /** @override */
  checkAvailability() {
    if (this.isSubMenuOpened) {
      this.button_.classList.add('shaka-hidden')
    } else {
      this.button_.classList.remove('shaka-hidden')
    }
  }
}
