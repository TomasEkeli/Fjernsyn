import shaka from 'shaka-player'

import i18n from '../../../i18n/index'
import { PlayerIcons } from '../../../../constants'

/**
 * Copies the playing video's link from inside the player, so that it can be
 * had in full window and fullscreen without leaving either. What is copied, and
 * the notice that it was, are the player's: this only asks for it.
 */
export class CopyLinkButton extends shaka.ui.Element {
  /**
   * @param {EventTarget} events
   * @param {HTMLElement} parent
   * @param {shaka.ui.Controls} controls
   */
  constructor(events, parent, controls) {
    super(parent, controls)

    /** @private */
    this.button_ = document.createElement('button')
    this.button_.classList.add('copy-link-button', 'shaka-tooltip')

    // eslint-disable-next-line no-new
    new shaka.ui.Icon(this.button_, PlayerIcons.LINK_FILLED)

    const label = document.createElement('label')
    label.classList.add(
      'shaka-overflow-button-label',
      'shaka-overflow-menu-only',
      'shaka-simple-overflow-button-label-inline'
    )

    /** @private */
    this.nameSpan_ = document.createElement('span')
    label.appendChild(this.nameSpan_)

    this.button_.appendChild(label)

    this.parent.appendChild(this.button_)

    // listeners

    this.eventManager.listen(this.button_, 'click', () => {
      events.dispatchEvent(new CustomEvent('copyLink'))
    })

    this.eventManager.listen(events, 'localeChanged', () => {
      this.updateLocalisedStrings_()
    })

    this.updateLocalisedStrings_()
  }

  /** @private */
  updateLocalisedStrings_() {
    this.nameSpan_.textContent = this.button_.ariaLabel = i18n.global.t('Video.Player.Copy Link')
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
