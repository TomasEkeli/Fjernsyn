import shaka from 'shaka-player'

import i18n from '../../../i18n/index'
import { PlayerIcons } from '../../../../constants'

/**
 * Shows or hides a live's chat over the video, in every viewing mode. The
 * button only asks for the change: whether the chat is shown is a setting,
 * kept from one live to the next, and the player says when it changes.
 */
export class LiveChatOverlayButton extends shaka.ui.Element {
  /**
   * @param {boolean} shown
   * @param {EventTarget} events
   * @param {HTMLElement} parent
   * @param {shaka.ui.Controls} controls
   */
  constructor(shown, events, parent, controls) {
    super(parent, controls)

    /** @private */
    this.button_ = document.createElement('button')
    this.button_.classList.add('live-chat-overlay-button', 'shaka-tooltip')

    /** @private */
    this.icon_ = new shaka.ui.Icon(this.button_, PlayerIcons.CHAT_DEFAULT)

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
    this.shown_ = shown

    // listeners

    this.eventManager.listen(this.button_, 'click', () => {
      events.dispatchEvent(new CustomEvent('setLiveChatOverlay', {
        detail: !this.shown_
      }))
    })

    this.eventManager.listen(events, 'liveChatOverlayChanged', (/** @type {CustomEvent} */ event) => {
      this.shown_ = event.detail

      this.updateLocalisedStrings_()
    })

    this.eventManager.listen(events, 'localeChanged', () => {
      this.updateLocalisedStrings_()
    })

    this.updateLocalisedStrings_()
  }

  /** @private */
  updateLocalisedStrings_() {
    this.icon_.use(this.shown_ ? PlayerIcons.CHAT_FILLED : PlayerIcons.CHAT_DEFAULT)

    this.nameSpan_.textContent = i18n.global.t('Video.Player.Live Chat on Video')

    this.currentState_.textContent = this.localization.resolve(this.shown_ ? 'ON' : 'OFF')

    this.button_.ariaLabel = this.shown_
      ? i18n.global.t('Video.Player.Hide Live Chat on Video')
      : i18n.global.t('Video.Player.Show Live Chat on Video')
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
