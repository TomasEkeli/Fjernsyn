import shaka from 'shaka-player'

const LoadMode = shaka.Player.LoadMode

/**
 * The bottom of the bar, in dB relative to 100%. -40 dB is 1%, which is quiet
 * enough to be a floor while leaving the rest of the range room on the bar.
 */
const MIN_DB = -40

/**
 * @param {number} percent
 * @returns {number} the same volume in dB relative to 100%
 */
function percentToDb(percent) {
  if (percent <= 0) {
    return MIN_DB
  }

  return Math.max(MIN_DB, 20 * Math.log10(percent / 100))
}

/**
 * @param {number} db
 * @returns {number} the same volume as a percentage
 */
function dbToPercent(db) {
  // The very bottom of the travel is silence rather than 1%, the way an audio
  // fader's travel ends at minus infinity
  if (db <= MIN_DB) {
    return 0
  }

  return 100 * 10 ** (db / 20)
}

/**
 * A replacement for `shaka.ui.VolumeBar` whose range goes past 100%.
 *
 * It has to be a replacement rather than a subclass: everything that makes
 * shaka's volume bar work is `@private`, and therefore renamed by the closure
 * compiler in the compiled build that FreeTube uses, so none of it can be
 * overridden. `shaka.ui.RangeElement` on the other hand only relies on members
 * that survive that build.
 *
 * The bar always shows the *effective* volume, which is what the user hears.
 * That is the volume they asked for, times this video's loudness correction,
 * clamped to the ceiling. Up to 100% the video element produces it on its own;
 * above that the element sits at 100% and the gain stage supplies the rest.
 *
 * Its travel is logarithmic, so the bar's own values are dB relative to 100%
 * while everything it talks to stays in percent. Loudness correction spans a far
 * wider range than a linear bar can serve: measured content runs from 14% to
 * 883% effective, which linearly would put the thumb 1.4px and 88px along a
 * 100px bar. In dB that is -17 and +18.9, either side of the 100% mark, and
 * equal movement of the thumb is equal change in loudness wherever it is.
 */
export class VolumeBar extends shaka.ui.RangeElement {
  /**
   * @param {import('../FtShakaVideoPlayer.vue').VolumeState} state
   * @param {EventTarget} events
   * @param {!HTMLElement} parent
   * @param {!shaka.ui.Controls} controls
   */
  constructor(state, events, parent, controls) {
    super(
      parent,
      controls,
      ['shaka-volume-bar-container', 'ft-volume-bar-container'],
      ['shaka-volume-bar', 'ft-volume-bar']
    )

    /** @private */
    this.state_ = state

    /** @private {!shaka.extern.UIConfiguration} */
    this.config_ = this.controls.getConfig()

    if (!this.config_.alwaysShowVolumeBar) {
      this.container.classList.add('shaka-volume-bar-container-allow-hiding')
    }

    /**
     * States the effective volume whenever it differs from the volume the user
     * asked for. Without it a loudness correction would be invisible, as the bar
     * itself only appears while the controls are hovered.
     * @private
     */
    this.badge_ = document.createElement('span')
    this.badge_.classList.add('ft-volume-badge')
    this.badge_.ariaHidden = 'true'
    this.parent.appendChild(this.badge_)

    this.eventManager.listen(this.video, 'volumechange', () => {
      this.syncToPresentation_()
    })

    // The load mode, and with it whether boosting is possible at all, is only
    // known once the load has finished
    this.eventManager.listen(this.player, 'loaded', () => {
      this.updateRange_()
      this.applyPreferredVolume_()
      this.checkAvailability_()
    })

    this.eventManager.listenMulti(
      this.player,
      ['unloading', 'trackschanged'],
      () => {
        this.checkAvailability_()
      }
    )

    this.eventManager.listen(this.controls, 'caststatuschanged', () => {
      this.syncToPresentation_()
    })

    this.eventManager.listenMulti(
      this.localization,
      [shaka.ui.Localization.LOCALE_UPDATED, shaka.ui.Localization.LOCALE_CHANGED],
      () => {
        this.updateAriaLabel_()
      }
    )

    // The ceiling and the loudness correction both come from outside this element
    this.eventManager.listen(events, 'volumeSettingsChanged', () => {
      this.updateRange_()
      this.applyPreferredVolume_()
    })

    this.eventManager.listen(this.container, 'wheel', (event) => {
      this.onWheel_(/** @type {!WheelEvent} */ (event))
    })

    this.updateRange_()

    if (this.player.getLoadMode() === LoadMode.NOT_LOADED) {
      this.applyPreferredVolume_()
    } else {
      // The UI is rebuilt from scratch whenever it is reconfigured, so this
      // element gets replaced mid playback. Whatever the volume is at that point
      // is the volume the user is listening to, and must not be reset.
      this.syncToPresentation_()
    }

    this.updateAriaLabel_()
    this.checkAvailability_()
  }

  /** @override */
  release() {
    this.badge_.remove()

    super.release()
  }

  /**
   * Update the video element's state to match the input element's state.
   * Called by the base class when the input element changes.
   *
   * @override
   */
  onChange() {
    const effectivePercent = dbToPercent(this.getValue())

    // Remember what the user asked for without this video's correction baked in,
    // so that the preference carries to the next video rather than the correction.
    // This happens before the volume is applied so that the player's own handling
    // of being dragged all the way down to zero gets the last word.
    this.state_.setBasePercent(effectivePercent / this.state_.normalizationGain)

    this.applyEffectiveVolume_(effectivePercent)

    if (effectivePercent > 0) {
      this.video.muted = false
    }

    this.updateBadge_()
  }

  /**
   * The effective volume the user's preference works out to for this video.
   * @returns {number}
   * @private
   */
  get effectivePercent_() {
    const maxPercent = dbToPercent(parseFloat(this.bar.max))

    return Math.min(this.state_.basePercent * this.state_.normalizationGain, maxPercent)
  }

  /**
   * Puts the user's volume preference, corrected for this video's loudness, into effect.
   * @private
   */
  applyPreferredVolume_() {
    this.applyEffectiveVolume_(this.effectivePercent_)
  }

  /**
   * Splits an effective volume between the video element and the gain stage, as
   * the element itself refuses anything above 100%.
   *
   * Whichever of the two factors is going down is set first, so that the change
   * never momentarily lands on top of the other factor's old value.
   *
   * @param {number} effectivePercent
   * @private
   */
  applyEffectiveVolume_(effectivePercent) {
    const clamped = Math.min(Math.max(effectivePercent, 0), dbToPercent(parseFloat(this.bar.max)))

    if (clamped <= 100) {
      this.state_.setGain(1)
      this.video.volume = clamped / 100
    } else {
      this.video.volume = 1
      this.state_.setGain(clamped / 100)
    }

    // Changing the gain doesn't make the element fire anything, and neither does
    // assigning the volume it already had, so tell the rest of the player itself.
    // This is what gets the new volume persisted and into the stats overlay.
    this.video.dispatchEvent(new Event('volumechange'))
  }

  /**
   * @private
   */
  syncToPresentation_() {
    const actualPercent = this.video.muted ? 0 : this.video.volume * this.state_.gain * 100

    this.setValue(percentToDb(actualPercent))

    this.updateColors_()
    this.updateBadge_()
  }

  /**
   * @private
   */
  updateRange_() {
    // A cross origin element without permissive headers feeds silence into
    // `createMediaElementSource`, and legacy formats are loaded straight from a
    // googlevideo URL through `src=`. The video element is marked
    // `crossorigin="anonymous"` so those headers should be there, but silence is
    // a bad enough failure that boosting is only offered where it is known to work.
    const canBoost = this.state_.maxPercent > 100 &&
      this.player.getLoadMode() === LoadMode.MEDIA_SOURCE

    const maxDb = percentToDb(canBoost ? this.state_.maxPercent : 100)

    this.setRange(MIN_DB, maxDb)

    // Where 100% sits along the bar. A logarithmic bar puts it in the middle
    // rather than at the end, so it needs a mark of its own, and the boost zone
    // is tinted from there on.
    const unityPosition = ((0 - MIN_DB) / (maxDb - MIN_DB)) * 100

    this.container.style.setProperty('--ft-volume-unity-position', `${unityPosition}%`)
    this.container.classList.toggle('ft-can-boost', canBoost)
  }

  /**
   * @private
   */
  updateColors_() {
    const colors = this.config_.volumeBarColors

    const min = parseFloat(this.bar.min)
    const max = parseFloat(this.bar.max)
    const fraction = ((this.getValue() - min) / (max - min)) * 100

    const gradient = [
      'to right',
      `${colors.level}${fraction}%`,
      `${colors.base}${fraction}%`,
      `${colors.base}100%`
    ]

    this.container.style.background = `linear-gradient(${gradient.join(',')})`
  }

  /**
   * @private
   */
  updateBadge_() {
    // What is actually coming out, rather than what was asked for, so that a
    // boost that was refused doesn't get announced as though it had happened
    const actualPercent = this.video.volume * this.state_.gain * 100

    const differs = !this.video.muted &&
      Math.round(actualPercent) !== Math.round(this.state_.basePercent)

    this.badge_.textContent = differs ? `${Math.round(actualPercent)}%` : ''
    this.badge_.classList.toggle('ft-visible', differs)
  }

  /**
   * @private
   */
  updateAriaLabel_() {
    // `shaka.ui.Locales.Ids` isn't exported from the compiled build, but the ids
    // it holds are plain strings and shaka does ship a translation for this one
    this.bar.ariaLabel = this.localization.resolve('VOLUME')
  }

  /**
   * @private
   */
  checkAvailability_() {
    // `shaka.ui.Utils.setDisplay` isn't exported from the compiled build
    this.container.style.display = this.player.isVideoOnly() ? 'none' : ''
  }

  /**
   * Handle mouse wheel input to control volume.
   * @param {!WheelEvent} event
   * @private
   */
  onWheel_(event) {
    // Ignore browser zoom gestures
    if (event.ctrlKey || event.metaKey) {
      return
    }

    event.preventDefault()

    // A dB per notch, the bar's travel being logarithmic
    const newValue = this.getValue() + (event.deltaY > 0 ? -1 : 1)

    this.setValue(Math.max(
      parseFloat(this.bar.min),
      Math.min(parseFloat(this.bar.max), newValue)
    ))

    this.onChange()
  }
}
