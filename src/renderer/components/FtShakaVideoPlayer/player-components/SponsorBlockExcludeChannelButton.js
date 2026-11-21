import shaka from 'shaka-player'

import i18n from '../../../i18n/index'
import { PlayerIcons } from '../../../../constants'

/**
 * Switches SponsorBlock's skipping off and on again for the playing video's
 * channel, from inside the player, so it can be had in full window and
 * fullscreen. The same switch as the eye-slash under the video: the button only
 * asks for the change, and the player says when the list has changed, whoever
 * changed it. Icon and label say how things are, as autoplay's do: a slashed
 * dollar while segments are skipped, a dollar while they are played.
 */
export class SponsorBlockExcludeChannelButton extends shaka.ui.Element {
  /**
   * @param {boolean} excluded whether the channel is on the list now
   * @param {EventTarget} events
   * @param {HTMLElement} parent
   * @param {shaka.ui.Controls} controls
   */
  constructor(excluded, events, parent, controls) {
    super(parent, controls)

    /** @private */
    this.button_ = document.createElement('button')
    this.button_.classList.add('sponsor-block-exclude-channel-button', 'shaka-tooltip')

    /** @private */
    this.icon_ = new shaka.ui.Icon(this.button_, PlayerIcons.MONEY_OFF_DEFAULT)

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
    this.excluded_ = excluded

    // listeners

    this.eventManager.listen(this.button_, 'click', () => {
      events.dispatchEvent(new CustomEvent('toggleSponsorBlockExcludedChannel'))
    })

    this.eventManager.listen(events, 'sponsorBlockExcludedChannelChanged', (/** @type {CustomEvent} */ event) => {
      this.excluded_ = event.detail

      this.updateLocalisedStrings_()
    })

    this.eventManager.listen(events, 'localeChanged', () => {
      this.updateLocalisedStrings_()
    })

    this.updateLocalisedStrings_()
  }

  /** @private */
  updateLocalisedStrings_() {
    this.icon_.use(this.excluded_ ? PlayerIcons.PAID_FILLED : PlayerIcons.MONEY_OFF_DEFAULT)

    this.nameSpan_.textContent = i18n.global.t('SponsorBlock.Skip On This Channel')

    this.currentState_.textContent = this.localization.resolve(this.excluded_ ? 'OFF' : 'ON')

    this.button_.ariaLabel = this.excluded_
      ? i18n.global.t('SponsorBlock.Not Skipped On This Channel')
      : i18n.global.t('SponsorBlock.Skipped On This Channel')
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
