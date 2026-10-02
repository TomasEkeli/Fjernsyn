// What the layer's watch view does to host the SABR regulator (ADR-0006,
// ADR-0016), beside the view rather than in it. The old watch view
// (views/Watch/Watch.js) is the model, and is not edited: its `created` hook,
// `onSabrRefreshRequested`, `onPlayerReloadRequested`, the give-up and failed
// transport checks of `handlePlayerError`, and the reset of `retryVideo`.
//
// It hosts and decides nothing. When to refresh, rebuild, reload the page or
// give up is the regulator's, and what a `null` from `renew` means is too. It:
//
// - creates the regulator once per view instance, raw, reading the regulated
//   streaming setting through a function, since the router reuses the view
//   across videos and the regulator reads it again for each new one;
// - holds the current credentials, expiry and SABR manifest: the source's
//   when it arrives, then whatever `renew` answered, as the source never
//   changes;
// - answers the player's refresh and rebuild requests through `renew`;
// - asks the view to reload the page, keeping the position, when the ladder
//   says so; the budgets survive that reload, as they must to bound it;
// - resets the regulator for any other load (a new video, or the viewer
//   trying again), which is when the ladder is to be forgotten;
// - tells the view which player errors are the end of the ladder, and which
//   are a failure of the SABR transport rather than of a format.

import shaka from 'shaka-player'
import { computed, markRaw, shallowRef, toValue, watch } from 'vue'

import { createSabrRegulator, SabrGiveUpError } from '../../helpers/player/SabrRegulator'
import { showToast } from '../../helpers/utils'

/** @typedef {import('../../platform/shapes').PlaybackSource} PlaybackSource */
/** @typedef {import('../../platform/shapes').SabrPlaybackSource} SabrPlaybackSource */
/** @typedef {import('../../platform/shapes').SabrData} SabrData */

/**
 * @typedef {object} HeldSession what is current for one `sabr` source
 * @property {SabrPlaybackSource} source
 * @property {SabrData} sabrData
 * @property {Date | null} expiresAt
 * @property {string} manifestUrl
 * @property {string} manifestMimeType
 */

/**
 * @param {import('vue').MaybeRefOrGetter<PlaybackSource | null>} source the
 *   source the view plays, `null` while there is none
 * @param {object} options
 * @param {() => boolean} options.isRegulated reads the regulated streaming
 *   setting, when the regulator asks
 * @param {() => number | null} options.currentPosition where playback is,
 *   `null` before the player has loaded
 * @param {(position: number | null) => Promise<void> | void} options.reload
 *   loads the video again from the layer, starting at `position` where it is
 *   not `null`; settles once the new source is in
 */
export function useSabrHosting(source, { isRegulated, currentPosition, reload }) {
  /**
   * `markRaw`: it holds a live session and event handlers, none of which
   * want a reactive proxy. Only where the Local API is, as SABR is.
   *
   * @type {import('../../helpers/player/SabrRegulator').SabrRegulator | null}
   */
  const regulator = process.env.SUPPORTS_LOCAL_API
    ? markRaw(createSabrRegulator({ isRegulated }))
    : null

  /** @type {import('vue').ShallowRef<HeldSession | null>} */
  const held = shallowRef(null)

  /** Whether the load under way is the page reload the ladder asked for */
  let reloadingForLadder = false

  // Synchronous, so that the reset is done before the player for the new
  // source is mounted and attaches to the regulator
  watch(() => toValue(source), (next) => {
    // Between two loads there is no source, which is not a video
    if (next === null || next === undefined) {
      return
    }

    held.value = next.transport === 'sabr'
      ? {
          source: next,
          sabrData: next.sabrData,
          expiresAt: next.expiresAt ?? null,
          manifestUrl: next.manifestUrl,
          manifestMimeType: next.manifestMimeType,
        }
      : null

    // The ladder's own page reload keeps its budgets, or they would bound
    // nothing. Any other load starts it afresh: forgetting the last video
    // makes this one's first session a new video's to the regulator, with a
    // full budget, the setting read again and its log line saying so
    if (regulator !== null && !reloadingForLadder) {
      regulator.reset(null)
    }
  }, { flush: 'sync', immediate: true })

  /** The held session, if it is for the source playing now */
  function current() {
    const session = held.value
    return session !== null && session.source === toValue(source) ? session : null
  }

  /** The credentials to hand the player, `null` for a source that is not `sabr` */
  const sabrData = computed(() => current()?.sabrData ?? null)

  /** When the current streaming URLs expire, `null` where unknown or not `sabr` */
  const expiresAt = computed(() => current()?.expiresAt ?? null)

  /** The SABR manifest to play: the source's, or a rebuild's since */
  const manifestUrl = computed(() => current()?.manifestUrl ?? null)
  const manifestMimeType = computed(() => current()?.manifestMimeType ?? '')

  /**
   * The player's `sabr-refresh-requested`, for a refresh and a rebuild alike:
   * fresh credentials through the source's `renew`, held and handed on, with
   * a rebuild's manifest. `null` where `renew` has none, or where the source
   * has changed meanwhile, as the player that asked is then gone.
   *
   * @param {{
   *   onResult: (result: { sabrData: SabrData, formatIds: string[], manifestSrc?: string, manifestMimeType?: string } | null) => void,
   *   reloadPlaybackContext?: object,
   *   rebuilding?: boolean
   * }} payload
   */
  async function onSabrRefreshRequested({ onResult, reloadPlaybackContext, rebuilding = false }) {
    const session = current()

    if (session === null) {
      onResult(null)
      return
    }

    let result = null

    try {
      result = await session.source.renew({ reloadPlaybackContext, rebuilding })
    } catch (error) {
      // `renew` answers `null` rather than throwing; this is in case it ever does
      console.error('SABR credential refresh failed', error)
    }

    if (result === null || result === undefined || current() !== session) {
      onResult(null)
      return
    }

    const next = { ...session, sabrData: result.sabrData, expiresAt: result.expiresAt }

    if (!rebuilding) {
      held.value = next
      onResult({ sabrData: result.sabrData, formatIds: result.formatIds })
      return
    }

    // The manifest is held too, so that a later switch of format loads the
    // one agreeing with the session the player is about to start
    if (result.manifestUrl) {
      next.manifestUrl = result.manifestUrl
      next.manifestMimeType = result.manifestMimeType
    }

    held.value = next
    onResult({
      sabrData: result.sabrData,
      formatIds: result.formatIds,
      manifestSrc: result.manifestUrl,
      manifestMimeType: result.manifestMimeType,
    })
  }

  /**
   * The player's `player-reload-requested`: the ladder's page reload, the
   * most expensive remedy, from where playback was. The reason travels with
   * the request and is shown, as on the old view.
   *
   * @param {string} [reason] what asked for it; an emitter may send none
   */
  async function onPlayerReloadRequested(reason) {
    const cause = reason ?? 'a SABR request'

    console.warn(`[SABR recovery] reloading the page: ${cause}`)
    showToast(`Reloading player: ${cause}`)

    const position = Math.floor(currentPosition() ?? 0)

    reloadingForLadder = true

    try {
      await reload(position > 0 ? position : null)
    } finally {
      reloadingForLadder = false
    }
  }

  /**
   * Whether a player error is the regulator's verdict that nothing left can
   * make the session play (ADR-0011): the end of the ladder, which the format
   * ring cannot help with, as the legacy URLs answer to the same session.
   *
   * @param {any} error a player error
   */
  function isEndOfLadder(error) {
    return error?.code === shaka.util.Error.Code.HTTP_ERROR && error.data?.[1] instanceof SabrGiveUpError
  }

  /**
   * Whether a player error is a failure of the SABR transport rather than of
   * a format. Adaptive and audio are then the same refused session, and only
   * the legacy formats, fetched over their own URLs, are worth trying.
   *
   * @param {any} error a player error
   */
  function isTransportFailure(error) {
    return error?.category === shaka.util.Error.Category.NETWORK &&
      typeof error.data?.[0] === 'string' &&
      error.data[0].startsWith('sabr:')
  }

  return {
    regulator,
    sabrData,
    expiresAt,
    manifestUrl,
    manifestMimeType,
    onSabrRefreshRequested,
    onPlayerReloadRequested,
    isEndOfLadder,
    isTransportFailure,
  }
}
