import { base64ToU8, concatenateChunks, EventEmitterLike, MAX_INT32_VALUE } from 'googlevideo/utils'
import { UmpReader } from 'googlevideo/ump'
import {
  UMPPartId,
  VideoPlaybackAbrRequest,
  StreamProtectionStatus,
  SabrError,
  SabrRedirect,
  MediaHeader,
  SabrContextSendingPolicy,
  SabrContextUpdate,
  SabrContextWritePolicy,
  NextRequestPolicy,
  ReloadPlaybackContext,
} from 'googlevideo/protos'
import shaka from 'shaka-player'

import { deepCopy } from '../utils'
import { injectedBackoffMs, injectedProtectionStatus, injectedReloadPlaybackContext, noteCredentialsInstalled, noteSessionServing, sabrWallInjectionEnabled, shouldInjectServerReload, shouldInjectWall } from './sabrWallInjection'

const AbortableOperation = shaka.util.AbortableOperation
const ShakaError = shaka.util.Error

/**
 * How many times to retry a segment that the server answered with a
 * NextRequestPolicy and no media, while attestation is pending.
 * Retrying sends a byte identical request, so a high number achieves nothing
 * except hammering the server.
 */
const ATTESTATION_RETRY_LIMIT = 3

/**
 * How many server requested backoffs within a single request, and how many
 * NextRequestPolicy retries, count as a loop worth doing something about.
 *
 * Both numbers are upstream's and both are kept as they were. What has changed
 * is what they authorise. A backoff is the server saying "ask again shortly",
 * which it does routinely as traffic shaping, and three of those is not proof
 * that asking will never work; nor is a redirect heavy session that ratchets
 * the same counter without any refusal at all. Upstream reloaded the whole
 * watch page the moment either number was reached, discarding a buffer that
 * was usually full and, when the cause was a refused session, pre-empting the
 * credential refresh that would have fixed it without the viewer noticing.
 *
 * So they now raise a suspicion, and the buffer decides what to do with it.
 */
const BACKOFF_LOOP_SUSPECTED_AT = 3
const RETRY_LOOP_SUSPECTED_AT = 100

/**
 * What a `RELOAD_PLAYER_RESPONSE` part says, in the words the viewer sees and
 * the regulator logs.
 */
const SERVER_RELOAD_REASON = 'the server asked for a player reload'

/**
 * @typedef OperationInputs
 * @type {object}
 * @property {string} uri
 * @property {shaka.extern.Request} request
 * @property {shaka.net.NetworkingEngine.RequestType} requestType
 * @property {shaka.extern.HeadersReceived} headersReceived
 * The following are calculated from above properties
 * @property {string} formatIdString
 * @property {boolean} isInit
 * @property {number} sequenceNumber
 */
/**
 * @typedef AbortStatus
 * @type {object}
 * @property {boolean} cancelled
 * @property {boolean} timedOut
 * @property {boolean} playerReloadRequested
 * @property {boolean} finished
 */
/**
 * @typedef CurrentState
 * @type {object}
 * @property {Map<string, Uint8Array>} initDataCache
 * @property {VideoPlaybackAbrRequest} abrRequest
 * @property {RequestInit} requestInit
 * @property {AbortStatus} abortStatus
 * @property {AbortController} abortController
 * @property {SabrStreamState} sabrStreamState
 * @property {?TimeoutController} timeoutController
 * @property {?EventEmitterLike} eventEmitter
 * @property {number} cumulativeBackOffTimeMs
 * @property {number} cumulativeBackOffRequested
 * @property {number} cumulativeRetryDueToNextRequestPolicy
 * @property {boolean} loopSuspicionLogged whether this request has already said it suspects a loop
 * @property {number} generation
 * @property {import('./SabrRegulator').SabrRecovery} recovery who decides what to do when the server stops serving
 * @property {(abrRequest: VideoPlaybackAbrRequest, builtAtGeneration: number) => number} applyCredentials
 * @property {() => ?PendingRefresh} getPendingRefresh
 * @property {() => void} beginRefresh
 * @property {number} sessionStartedAt
 * @property {() => boolean} isTornDown
 */
/**
 * @typedef PendingRefresh
 * @type {object}
 * @property {Promise<void>} promise
 * @property {() => void} resolve
 * @property {(error: Error) => void} reject
 */
/**
 * @typedef SabrStreamState
 * @type {object}
 * @property {string} sabrUrl
 * @property {Set<number>} activeSabrContextTypes
 * @property {Map<number, SabrContextUpdate>} sabrContexts
 * @property {?NextRequestPolicy} nextRequestPolicy
 * @property {boolean} playerReloadRequested
 * @property {number} requestNumber
 * @property {boolean} refreshInFlight
 * @property {boolean} hasServedMedia
 */
/**
 * @typedef TimeoutController
 * @type {object}
 * @property {() => void} resetTimeoutOnce
 * @property {() => void} suspend
 * @property {() => void} resume
 * @property {() => void} clearTimeout
 */
/**
 * @typedef SabrSession
 * @type {object}
 * @property {shaka.extern.SchemePlugin} handleRequest
 * @property {(cb: ({backoffMs: number}) => void) => void} onBackoffRequested
 * @property {(cb: (payload: { reason: string }) => void) => void} onReloadOnce
 * @property {(cb: () => void) => void} onRefreshNeeded
 * @property {(cb: (payload: { reason: string }) => void) => void} onHardReloadNeededOnce
 * @property {(newSabrData: import('../../views/Watch/Watch').SabrData) => void} refresh
 * @property {(error: Error) => void} abandonRefresh
 * @property {() => string[]} getFormatIds
 * @property {() => void | undefined} cleanup
 */

/**
 * @param {string} str
 */
function formatIdFromString(str) {
  const videoFormatIdParts = str.split('-')

  return {
    itag: parseInt(videoFormatIdParts[0]),
    lastModified: videoFormatIdParts[1],
    xtags: videoFormatIdParts[2].length === 0 ? undefined : videoFormatIdParts[2]
  }
}

/**
 * @param {import('googlevideo/protos').FormatId} formatId
 * @param {shaka.extern.BufferedRange} buffered
 * @param {shaka.media.SegmentIndex} segmentIndex
 */
function createBufferedRange(formatId, buffered, segmentIndex) {
  let endSegmentIndex = segmentIndex.find(buffered.end)
  if (endSegmentIndex == null) {
    // Using Last end time will get `null` in `segmentIndex.find`
    endSegmentIndex = segmentIndex.getNumReferences() - 1
  }

  return {
    formatId,
    startTimeMs: String(Math.round(buffered.start * 1000)),
    durationMs: String(Math.round((buffered.end - buffered.start) * 1000)),
    startSegmentIndex: segmentIndex.find(buffered.start),
    endSegmentIndex: endSegmentIndex,
  }
}

/**
 * Creates a bogus buffered range for a format. Used when we want to signal to the server to not send any
 * segments for this format.
 * @param {import('googlevideo/protos').FormatId} formatId - The format to create a full buffer range for.
 * @returns {import('googlevideo/protos').BufferedRange} A BufferedRange object indicating the entire format is buffered.
 */
function createFullBufferRange(formatId) {
  return {
    formatId: formatId,
    durationMs: MAX_INT32_VALUE,
    startTimeMs: '0',
    startSegmentIndex: parseInt(MAX_INT32_VALUE),
    endSegmentIndex: parseInt(MAX_INT32_VALUE),
    timeRange: {
      durationTicks: MAX_INT32_VALUE,
      startTicks: '0',
      timescale: 1000
    }
  }
}

/**
 * @param {shaka.Player} player
 * @param {shaka.extern.Manifest} manifest
 * @param {boolean} audioFormatsActive
 * @param {boolean} streamIsVideo - Fake audio bufferRange can be used
 * @param {boolean} streamIsAudio - Fake video bufferRange can be used
 * @param {import('googlevideo/protos').BufferedRange[]} bufferedRanges
 * @param {shaka.extern.Track} activeVariant
 */
function fillBufferedRanges(player, manifest, audioFormatsActive, streamIsVideo, streamIsAudio, bufferedRanges, activeVariant) {
  const bufferedInfo = player.getBufferedInfo()

  if (bufferedInfo.audio.length > 0 || bufferedInfo.video.length > 0) {
    let activeManifestVariant
    if (audioFormatsActive) {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId
      })
    } else {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId &&
          variant.video.originalId === activeVariant.originalVideoId
      })
    }

    const audioFormatId = formatIdFromString(activeVariant.originalAudioId)
    const audioSegmentIndex = activeManifestVariant.audio.segmentIndex

    if (streamIsVideo) {
      bufferedRanges.push(createFullBufferRange(audioFormatId))
    } else {
      for (const buffered of bufferedInfo.audio) {
        bufferedRanges.push(createBufferedRange(audioFormatId, buffered, audioSegmentIndex))
      }
    }

    // Lazily initialize these variables as video data won't exist for audio-only playback
    let videoFormatId
    let videoSegmentIndex

    if (streamIsAudio && bufferedInfo.video.length > 0) {
      videoFormatId = formatIdFromString(activeVariant.originalVideoId)
      bufferedRanges.push(createFullBufferRange(videoFormatId))
    } else {
      for (const buffered of bufferedInfo.video) {
        if (!videoFormatId) {
          videoFormatId = formatIdFromString(activeVariant.originalVideoId)
        }

        if (!videoSegmentIndex) {
          videoSegmentIndex = activeManifestVariant.video.segmentIndex
        }

        bufferedRanges.push(createBufferedRange(videoFormatId, buffered, videoSegmentIndex))
      }
    }
  }
}

/**
 * @param {string} uri
 * @param {shaka.extern.Request} request
 * @param {Uint8Array} data
 * @returns {shaka.util.AbortableOperation<shaka.extern.Response>}
 */
function createCacheResponse(uri, request, data) {
  return AbortableOperation.completed({
    data,
    fromCache: true,
    headers: {},
    originalRequest: request,
    originalUri: uri,
    uri
  })
}

/**
 * @param {shaka.util.Error.Code} code
 * @param {...any} args
 */
function createRecoverableNetworkError(code, ...args) {
  return new ShakaError(ShakaError.Severity.RECOVERABLE, ShakaError.Category.NETWORK, code, ...args)
}

/**
 * Ends this SABR session and asks for the named recovery. Requests already in
 * flight abort themselves once `playerReloadRequested` is set.
 *
 * The reason travels with the event because several unrelated causes end in
 * the same remedy, and one the viewer sees at most once a week. A reload that
 * cannot say what asked for it cannot be diagnosed afterwards.
 * @param {CurrentState} currentState
 * @param {'reload' | 'hard-reload-needed'} event
 * @param {string} reason names what asked for the recovery
 * @param {object} [payload] anything the remedy needs, such as the server's
 * reload context for a rebuild that must re-fetch the player response
 */
function endSessionForRecovery(currentState, event, reason, payload) {
  // A session that has been cleaned up has no player left to recover, and
  // asking for one reloads a page the viewer is already looking at
  if (currentState.isTornDown()) { return }

  // Only the first caller asks for a remedy. Audio and video reach the same
  // conclusion together, and the second one must not spend a second rung.
  const alreadyEnded = currentState.sabrStreamState.playerReloadRequested

  currentState.sabrStreamState.playerReloadRequested = true

  if (!currentState.abortController.signal.aborted) {
    currentState.abortController.abort()
  }

  // The emit used to sit inside that guard, and a request that had already
  // aborted its own controller therefore ended the session and told nobody.
  // A completed segment does exactly that (`MEDIA_END` aborts the request), so
  // any recovery decided after the media had arrived left the session marked
  // dead, every later request aborting against it, and no rebuild, no page
  // reload and no message. The one failure worse than the page reload this
  // work exists to remove.
  if (!alreadyEnded) {
    currentState.eventEmitter.emit(event, { ...payload, reason })
  }
}

/**
 * Asks the watch view to reload the player.
 * @param {CurrentState} currentState
 * @param {string} reason names what asked for the reload
 */
function requestPlayerReload(currentState, reason) {
  endSessionForRecovery(currentState, 'reload', reason)
}

/**
 * Ends the session as the regulator decided, without touching the request.
 *
 * Split out of `actOnRecoveryDecision` for the one caller that is not a
 * request site: a decision reached while reading UMP parts cannot throw,
 * because the read loop already ends the request when the session aborts, and
 * a throw from inside it would be re-read as a network failure.
 *
 * @param {import('./SabrRegulator').RecoveryDecision} decision
 * @param {CurrentState} currentState
 * @param {string} reloadLabel names the cause, for the log and the toast
 * @param {object} [payload] anything the remedy needs
 */
function endSessionAsDecided(decision, currentState, reloadLabel, payload) {
  if (decision.log) {
    console.warn(decision.log)
  }

  switch (decision.action) {
    case 'rebuild':
      endSessionForRecovery(currentState, 'hard-reload-needed', reloadLabel, payload)
      break
    case 'reload-page':
      requestPlayerReload(currentState, reloadLabel)
      break
  }
}

/**
 * Carries out what the regulator decided. Each remedy destroys state at a
 * different radius, and only the owner of that state can destroy it, so the
 * regulator decides and this performs: the session ends itself, and the
 * request ends with it.
 *
 * Always throws, so the caller's request ends here.
 * @param {import('./SabrRegulator').RecoveryDecision} decision
 * @param {CurrentState} currentState
 * @param {OperationInputs} operationInputs
 * @param {string} reloadLabel names the cause in the error a page reload throws
 */
function actOnRecoveryDecision(decision, currentState, operationInputs, reloadLabel) {
  endSessionAsDecided(decision, currentState, reloadLabel)

  switch (decision.action) {
    case 'reload-page':
      throw createRecoverableNetworkError(
        ShakaError.Code.HTTP_ERROR,
        operationInputs.uri,
        new Error(`Reloading player: ${reloadLabel}`),
        operationInputs.requestType,
      )
    case 'give-up':
      // CRITICAL because no retry of ours can change the answer: the verdict
      // travels as the error's cause, for the view to recognise by type
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.NETWORK,
        ShakaError.Code.HTTP_ERROR,
        operationInputs.uri,
        decision.error,
        operationInputs.requestType,
      )
  }

  // 'rebuild' and 'abort' both leave this request with nothing to do: the
  // session it belongs to is finished either way
  throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
}

/**
 * Answers the server's request for a player reload, real or injected, by
 * asking the ladder for a rebuild and handing it the server's token.
 *
 * @param {CurrentState} currentState
 * @param {object} reloadPlaybackContext the decoded `ReloadPlaybackContext`
 */
function answerServerReload(currentState, reloadPlaybackContext) {
  endSessionAsDecided(
    currentState.recovery.decideOnServerReload({
      description: SERVER_RELOAD_REASON,
      sessionEnded: currentState.sabrStreamState.playerReloadRequested,
    }),
    currentState,
    SERVER_RELOAD_REASON,
    { reloadPlaybackContext },
  )
}

/**
 * Re-applies the current credentials and SABR contexts to the request and
 * re-encodes the body. Needed before any re-send, because the encoded body
 * outlives the credentials it was built with.
 * @param {CurrentState} currentState
 */
function rebuildRequestBody(currentState) {
  currentState.generation = currentState.applyCredentials(currentState.abrRequest, currentState.generation)

  const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(currentState.sabrStreamState)

  currentState.abrRequest.streamerContext.sabrContexts = sabrContexts
  currentState.abrRequest.streamerContext.unsentSabrContexts = unsentSabrContexts

  let body

  try {
    body = VideoPlaybackAbrRequest.encode(currentState.abrRequest).finish()
  } catch (error) {
    console.error('Invalid VideoPlaybackAbrRequest data', currentState.abrRequest)
    throw error
  }

  currentState.requestInit = {
    ...currentState.requestInit,
    body,
  }
}

/**
 * Parks the request while a credential refresh is in flight, instead of
 * failing it. The player keeps playing from its buffer in the meantime. Once
 * released, the body is rebuilt against the fresh credentials. If the refresh
 * is abandoned, falls back to the old full player reload.
 * @param {OperationInputs} operationInputs
 * @param {CurrentState} currentState
 */
async function parkUntilRefreshed(operationInputs, currentState) {
  const pending = currentState.getPendingRefresh()
  if (!pending) return

  // Time spent parked is our latency, not the server's
  currentState.timeoutController?.suspend()

  try {
    await pending.promise
  } catch (error) {
    if (currentState.abortStatus.cancelled || currentState.isTornDown()) {
      // Woken by teardown, not by a failed refresh: bow out quietly
      throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
    }

    // The abandoning caller said why, in `abandonRefresh`; dropping it here is
    // what made two different failures reach the viewer as one message
    const reason = error?.message ?? 'SABR credential refresh abandoned'

    // This used to reload the page from here, which spent the most expensive
    // remedy without ever offering the rebuild rung above it. The ladder
    // decides now, as it does everywhere else.
    const decision = currentState.recovery.decideOnRefreshAbandoned({
      reason,
      sessionEnded: currentState.sabrStreamState.playerReloadRequested,
    })

    actOnRecoveryDecision(decision, currentState, operationInputs, `credential refresh abandoned (${reason})`)
  } finally {
    currentState.timeoutController?.resume()
  }

  // The retry and backoff history belongs to the dead session. Left in place,
  // the stale backoff tally plus the new session's routine start up backoff
  // trips the loop detector and forces the full reload this refresh exists to
  // avoid.
  currentState.cumulativeRetryDueToNextRequestPolicy = 0
  currentState.cumulativeBackOffRequested = 0
  currentState.cumulativeBackOffTimeMs = 0
  currentState.loopSuspicionLogged = false

  rebuildRequestBody(currentState)
}

/**
 * @param {SabrStreamState} sabrStreamState
 */
function prepareSabrContexts(sabrStreamState) {
  /** @type {SabrContextUpdate[]} */
  const sabrContexts = []
  /** @type {number[]} */
  const unsentSabrContexts = []

  for (const ctxUpdate of sabrStreamState.sabrContexts.values()) {
    if (sabrStreamState.activeSabrContextTypes.has(ctxUpdate.type)) {
      sabrContexts.push(ctxUpdate)
    } else {
      unsentSabrContexts.push(ctxUpdate.type)
    }
  }

  return { sabrContexts, unsentSabrContexts }
}

/**
 * @template T
 * @param {import('googlevideo/ump').CompositeBuffer} data
 * @param {{ decode: (data: Uint8Array) => T }} decoder
 * @returns {T | undefined}
 */
function decodePart(data, decoder) {
  if (!data.chunks.length) return undefined

  try {
    const chunk = data.chunks.length === 1 ? data.chunks[0] : concatenateChunks(data.chunks)
    return decoder.decode(chunk)
  } catch {
    return undefined
  }
}

/**
 * @param {(args: void) => void} callback
 * @param {number} timeoutMs
 * @return TimeoutController
 */
function createTimeoutController(callback, timeoutMs) {
  return {
    _timeout: setTimeout(callback, timeoutMs),
    _resetCount: 0,
    resetTimeoutOnce() {
      if (this._resetCount > 0) return

      this.clearTimeout()
      this._timeout = setTimeout(callback, timeoutMs)
      this._resetCount++
    },
    /**
     * Stops the clock without consuming the one shot reset. Used while a
     * request is parked waiting for fresh credentials: time spent parked is
     * our latency, not the server's, so it must not count against the request.
     */
    suspend() {
      clearTimeout(this._timeout)
    },
    resume() {
      this._timeout = setTimeout(callback, timeoutMs)
    },
    clearTimeout() {
      clearTimeout(this._timeout)
    },
  }
}

/**
 * @param {OperationInputs} operationInputs - readonly
 * @param {CurrentState} currentState - can be updated
 */
async function doRequest(
  operationInputs,
  currentState,
) {
  let response
  /** @type {Uint8Array[]} */
  const responseDataChunks = []
  let segmentComplete = false
  let shouldRetry = false
  let shouldRetryDueToNextRequestPolicy = false

  let invalidPoToken = false
  let error

  /** Latest value from a StreamProtectionStatus part. 2 means attestation pending. */
  let protectionStatus = 0
  let receivedMediaPart = false

  /** Only ever true when FT_SABR_WALL is set, see sabrWallInjection */
  const wallInjected = sabrWallInjectionEnabled && shouldInjectWall(currentState.sessionStartedAt)

  if (currentState.sabrStreamState.playerReloadRequested) {
    // Multiple requests might be issued at the same time, other requests should abort themselves once reload requested
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  }

  await parkUntilRefreshed(operationInputs, currentState)

  try {
    let shouldReloadDueToBackoffLoop = false
    if ((currentState.sabrStreamState.nextRequestPolicy?.backoffTimeMs || 0) > 0) {
      const currentBackoffTimeMs = currentState.sabrStreamState.nextRequestPolicy.backoffTimeMs
      currentState.eventEmitter.emit('backoff-requested', { backoffMs: currentBackoffTimeMs })
      // Wait but can be aborted
      await new Promise((resolve, reject) => {
        setTimeout(resolve, currentBackoffTimeMs)
        currentState.abortController.signal.addEventListener('abort', reject)
      })
      // Must reset AFTER waiting to avoid requested aborted
      // Since long backoff time mostly happens on the start of video playback we only reset timeout once
      // i.e. backoff time parts received will not reset timeout - counted as video loading issue
      currentState.timeoutController?.resetTimeoutOnce()

      currentState.cumulativeBackOffTimeMs += currentState.sabrStreamState.nextRequestPolicy.backoffTimeMs
      currentState.cumulativeBackOffRequested += 1
      const timeoutMs = operationInputs.request.retryParameters.timeout
      // Detect infinite backoff loop by no. of times requested and cumulative time approaching timeout
      if (currentState.cumulativeBackOffRequested >= BACKOFF_LOOP_SUSPECTED_AT || (timeoutMs > 0 && timeoutMs <= (currentState.cumulativeBackOffTimeMs + currentBackoffTimeMs))) {
        shouldReloadDueToBackoffLoop = true
      }
    }
    if (shouldReloadDueToBackoffLoop || currentState.cumulativeRetryDueToNextRequestPolicy >= RETRY_LOOP_SUSPECTED_AT) {
      const reason = shouldReloadDueToBackoffLoop
        ? `${currentState.cumulativeBackOffRequested} backoffs in one request, ${(currentState.cumulativeBackOffTimeMs / 1000).toFixed(1)}s of waiting`
        : `${currentState.cumulativeRetryDueToNextRequestPolicy} retries in one request`

      const decision = currentState.recovery.decideOnLoopSuspicion({
        description: reason,
        hasServedMedia: currentState.sabrStreamState.hasServedMedia,
        sessionEnded: currentState.sabrStreamState.playerReloadRequested,
      })

      if (decision.action === 'run-on') {
        // The same request can reach the same conclusion many times over, and
        // saying so once is enough
        if (!currentState.loopSuspicionLogged) {
          currentState.loopSuspicionLogged = true
          console.warn(decision.log)
        }
      } else {
        actOnRecoveryDecision(decision, currentState, operationInputs, 'SABR retry loop')
      }
    }

    const { itag, lastModified, xtags } = formatIdFromString(operationInputs.formatIdString)
    let mediaHeaderId

    const umpReader = new UmpReader({
      onPart: (type, data) => {
        // A simulated wall throws the media away and lets everything else
        // through, which is what the session sees when the server really
        // refuses to serve an untrusted token. Dropping MEDIA_END also keeps
        // the request retryable, since that is the part that finishes it.
        if (wallInjected && (
          type === UMPPartId.MEDIA ||
          type === UMPPartId.MEDIA_END ||
          type === UMPPartId.MEDIA_HEADER
        )) {
          return
        }

        switch (type) {
          case UMPPartId.STREAM_PROTECTION_STATUS: {
            const streamProtectionStatus = decodePart(data, StreamProtectionStatus)
            // A part that would not decode says nothing about the session, so
            // the last status we did read stands. Reading on from it would
            // also throw, and the throw lands in the part loop and abandons
            // the rest of the response, which is how a playback hangs.
            if (!streamProtectionStatus) break

            protectionStatus = streamProtectionStatus.status ?? 0

            // A trusted status used to clear the recovery budget here. It is
            // not proof of anything on its own: a session can keep answering
            // "trusted" while serving nothing, and every such answer put the
            // budget back to zero, so the escalation was never reached and the
            // video refreshed forever in front of a drained buffer. Media
            // actually arriving is the only proof, and noteMediaServed has it.
            if (streamProtectionStatus.status === 3) {
              invalidPoToken = true
            }
            break
          }
          case UMPPartId.SABR_ERROR: {
            const sabrError = decodePart(data, SabrError)
            if (!sabrError) break

            error = `SABR Error: type: ${sabrError.type}, code: ${sabrError.code}`
            break
          }
          case UMPPartId.SABR_REDIRECT: {
            const sabrRedirect = decodePart(data, SabrRedirect)
            if (!sabrRedirect?.url) break

            // The server sometimes sends a redirect part with an empty URL.
            // Applying it breaks every request in the session with
            // "Failed to construct 'URL'", so only follow parseable targets.
            if (sabrRedirect.url && URL.canParse(sabrRedirect.url)) {
              currentState.sabrStreamState.sabrUrl = sabrRedirect.url
              shouldRetry = true
            }
            break
          }
          case UMPPartId.MEDIA_HEADER: {
            if (mediaHeaderId === undefined) {
              const mediaHeader = decodePart(data, MediaHeader)
              if (!mediaHeader) break

              if (
                mediaHeader.formatId.itag === itag &&
                mediaHeader.formatId.lastModified === lastModified &&
                mediaHeader.formatId.xtags === xtags
              ) {
                if (operationInputs.isInit && mediaHeader.isInitializationSegment) {
                  mediaHeaderId = mediaHeader.headerId
                } else if (!operationInputs.isInit && mediaHeader.segmentNum === operationInputs.sequenceNumber) {
                  mediaHeaderId = mediaHeader.headerId
                }
              }
            }

            break
          }
          case UMPPartId.MEDIA: {
            receivedMediaPart = true
            if (mediaHeaderId === data.getUint8(0)) {
              responseDataChunks.push(...data.split(1).remainingBuffer.chunks)
            }
            break
          }
          case UMPPartId.MEDIA_END: {
            if (mediaHeaderId === data.getUint8(0)) {
              segmentComplete = true
              currentState.abortStatus.finished = true
              currentState.abortController.abort()
            }
            break
          }
          case UMPPartId.NEXT_REQUEST_POLICY: {
            const nextRequestPolicy = decodePart(data, NextRequestPolicy)

            shouldRetry = true
            shouldRetryDueToNextRequestPolicy = true

            currentState.sabrStreamState.nextRequestPolicy = nextRequestPolicy
            currentState.abrRequest.streamerContext.playbackCookie = nextRequestPolicy?.playbackCookie

            currentState.abrRequest.streamerContext.backoffTimeMs = nextRequestPolicy?.backoffTimeMs
            break
          }
          case UMPPartId.FORMAT_INITIALIZATION_METADATA: {
            break
          }
          case UMPPartId.SABR_CONTEXT_UPDATE: {
            const sabrContextUpdate = decodePart(data, SabrContextUpdate)
            if (!sabrContextUpdate) break

            if (sabrContextUpdate.type !== undefined && sabrContextUpdate.value?.length) {
              if (
                sabrContextUpdate.writePolicy === SabrContextWritePolicy.KEEP_EXISTING &&
                currentState.sabrStreamState.sabrContexts.has(sabrContextUpdate.type)
              ) {
                break
              }

              currentState.sabrStreamState.sabrContexts.set(sabrContextUpdate.type, sabrContextUpdate)

              if (sabrContextUpdate.sendByDefault) {
                currentState.sabrStreamState.activeSabrContextTypes.add(sabrContextUpdate.type)
              }
            }
            break
          }
          case UMPPartId.SABR_CONTEXT_SENDING_POLICY: {
            const sabrContextSendingPolicy = decodePart(data, SabrContextSendingPolicy)
            if (!sabrContextSendingPolicy) break

            for (const startPolicy of sabrContextSendingPolicy.startPolicy) {
              if (!currentState.sabrStreamState.activeSabrContextTypes.has(startPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.add(startPolicy)
              }
            }

            for (const stopPolicy of sabrContextSendingPolicy.stopPolicy) {
              if (currentState.sabrStreamState.activeSabrContextTypes.has(stopPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.delete(stopPolicy)
              }
            }

            for (const discardPolicy of sabrContextSendingPolicy.discardPolicy) {
              if (currentState.sabrStreamState.sabrContexts.has(discardPolicy)) {
                currentState.sabrStreamState.sabrContexts.delete(discardPolicy)
              }
            }
            break
          }
          case UMPPartId.RELOAD_PLAYER_RESPONSE: {
            const reloadPlaybackContext = decodePart(data, ReloadPlaybackContext)
            if (!reloadPlaybackContext) break

            // Upstream reads this as "the whole video cannot be played" and
            // reloads the page. The part says the opposite: it hands us a
            // token for re-fetching the player response, and the reference
            // implementation installs the new streaming URL and retries the
            // same segment. That is a session rebuild, so it climbs the ladder
            // like every other cause, carrying the token to the rebuild.
            //
            // The decision's own line is what makes this path visible at last;
            // it had none, so it was the one reload that left no trace.
            answerServerReload(currentState, reloadPlaybackContext)
            break
          }
          default: {
            break
          }
        }
      }
    })

    const sabrURL = new URL(currentState.sabrStreamState.sabrUrl)
    sabrURL.searchParams.set('rn', String(currentState.sabrStreamState.requestNumber++))
    response = await fetch(sabrURL.toString(), currentState.requestInit)

    operationInputs.headersReceived({})

    const reader = response.body.getReader()
    let readObj = await reader.read()

    while (!readObj.done && !currentState.abortStatus.finished) {
      await umpReader.feed(readObj.value)

      if (!currentState.abortStatus.finished) {
        readObj = await reader.read()
      }
    }
  } catch (error) {
    if (currentState.abortStatus.cancelled) {
      throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
    } else if (currentState.abortStatus.timedOut) {
      throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
    } else if (!currentState.abortStatus.finished) {
      throw createRecoverableNetworkError(ShakaError.Code.HTTP_ERROR, operationInputs.uri, error, operationInputs.requestType)
    }
  }

  if (currentState.abortStatus.cancelled) {
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  } else if (currentState.abortStatus.timedOut) {
    throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
  }

  // A server reload the server did not send. It goes here rather than in the
  // part loop because a fabricated part would have to be spliced into a stream
  // that has already been read; everything downstream of the decode is what is
  // being tested, and this is where that starts.
  if (sabrWallInjectionEnabled && shouldInjectServerReload(currentState.sabrStreamState.requestNumber)) {
    answerServerReload(currentState, injectedReloadPlaybackContext())

    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  }

  if (wallInjected) {
    // Answer as a walled session does, whatever the server actually said
    protectionStatus = injectedProtectionStatus()

    if (protectionStatus === 3) {
      // A rejected token comes with nothing to retry: the server has judged
      // this token, and sending it again cannot change the verdict
      invalidPoToken = true
    } else {
      shouldRetry = true
      shouldRetryDueToNextRequestPolicy = true
    }

    const backoffMs = injectedBackoffMs()

    if (backoffMs > 0) {
      // Only a refused request retries inside itself, and the loop detector
      // counts backoffs within one request, so this is the one place a
      // countable backoff can be injected from. The rewriting stops at what we
      // received: the outgoing streamerContext still echoes the server's own
      // number, so the real conversation is not told anything untrue.
      if (currentState.sabrStreamState.nextRequestPolicy) {
        currentState.sabrStreamState.nextRequestPolicy.backoffTimeMs = backoffMs
      } else {
        currentState.sabrStreamState.nextRequestPolicy = /** @type {NextRequestPolicy} */ ({ backoffTimeMs: backoffMs })
      }
    }
  }

  // The server answered without media because it does not trust the PO token.
  // Retrying sends an identical request, so it cannot succeed; a fresh token
  // sometimes is trusted, and that is rung 0 of the ladder.
  //
  // The two refusals differ only in how long to humour them. A pending
  // attestation (status 2) arrives with a retry directive, so it is not a wall
  // until those retries are spent. A rejected token (status 3) has nothing to
  // retry: the server has already said what it thinks of this token, and
  // sending it again cannot change that answer. It used to skip the ladder
  // altogether and fail the video outright, which is the wrong way round, and
  // wrong on the evidence: reopening a video that died this way plays it back
  // in the same formats, because reopening is what mints the new token.
  const attestationBlocked = !receivedMediaPart && (
    invalidPoToken ||
    (protectionStatus >= 2 && currentState.cumulativeRetryDueToNextRequestPolicy >= ATTESTATION_RETRY_LIMIT)
  )

  if (responseDataChunks.length > 0 && segmentComplete) {
    const data = /** @__NOINLINE__ */ concatenateChunks(responseDataChunks)

    currentState.sabrStreamState.hasServedMedia = true

    currentState.recovery.noteMediaServed()
    noteSessionServing()

    if (operationInputs.isInit) {
      currentState.initDataCache.set(operationInputs.formatIdString, data)
    }

    /** @type {shaka.extern.Response} */
    return {
      uri: operationInputs.uri,
      originalUri: operationInputs.uri,
      data,
      status: response.status,
      headers: {},
      fromCache: false,
      originalRequest: operationInputs.request,
    }
  } else if (attestationBlocked) {
    const decision = currentState.recovery.decideOnRefusal({
      hasServedMedia: currentState.sabrStreamState.hasServedMedia,
      sessionEnded: currentState.sabrStreamState.playerReloadRequested,
    })

    if (decision.action !== 'refresh') {
      actOnRecoveryDecision(decision, currentState, operationInputs, 'SABR attestation recovery')
    }

    // Audio and video requests hit this at the same time, so only the first
    // one starts the refresh and counts it against the budget. Both then park
    // until the fresh credentials arrive and retry with them, without the
    // player being torn down.
    if (!currentState.sabrStreamState.refreshInFlight) {
      currentState.sabrStreamState.refreshInFlight = true

      currentState.recovery.noteRefreshStarted()

      currentState.beginRefresh()
      currentState.eventEmitter.emit('refresh-needed')
    }

    // parkUntilRefreshed resets the per session counters on resume
    await parkUntilRefreshed(operationInputs, currentState)

    currentState.abortStatus.timedOut = false
    currentState.abortStatus.finished = false
    return doRequest(operationInputs, currentState)
  } else if (shouldRetry) {
    if (shouldRetryDueToNextRequestPolicy) {
      // Only count on actual retry to avoid counting false positive (when segmentComplete
      currentState.cumulativeRetryDueToNextRequestPolicy += 1
    }

    rebuildRequestBody(currentState)
    currentState.abortStatus.timedOut = false

    currentState.abortStatus.finished = false
    return doRequest(operationInputs, currentState)
  } else if (invalidPoToken) {
    throw new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.NETWORK,
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Invalid PO token'),
      operationInputs.requestType,
    )
  } else if (error) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error(error),
      operationInputs.requestType,
    )
  } else if (responseDataChunks.length > 0 && !segmentComplete) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Incomplete segment, missing MEDIA_END part'),
      operationInputs.requestType,
    )
  } else if (response.status === 200) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Empty response, this should not happen'),
      operationInputs.requestType,
    )
  } else {
    const severity = response.status === 401 || response.status === 403
      ? ShakaError.Severity.CRITICAL
      : ShakaError.Severity.RECOVERABLE

    throw new ShakaError(
      severity,
      ShakaError.Category.NETWORK,
      ShakaError.Code.BAD_HTTP_STATUS,
      operationInputs.uri,
      response.status,
      '',
      {},
      operationInputs.requestType,
      operationInputs.uri,
    )
  }
}

/**
 * Builds one SABR streaming session: its credentials, its protocol state, and
 * the request handler that speaks for it.
 *
 * It does not register the handler anywhere. The `sabr://` scheme slot is
 * process-global and a session is the shortest lived thing in the player, so a
 * session that claimed the slot could only ever be replaced by first giving it
 * up, which is what made every rebuild visible to the viewer. The regulator
 * owns the slot instead and routes to whichever session it is currently
 * serving from; see `SabrRegulator.js`.
 *
 * @param {import('../../views/Watch/Watch').SabrData} sabrData
 * @param {import('./SabrRegulator').SabrRecovery} recovery who decides what to do when the server stops serving
 * @param {() => shaka.Player} getPlayer
 * @param {() => shaka.extern.Manifest} getManifest
 * @param {import('vue').ComputedRef<number>} playerWidth
 * @param {import('vue').ComputedRef<number>} playerHeight
 * @return SabrSession
 */
export function createSabrSession(sabrData, recovery, getPlayer, getManifest, playerWidth, playerHeight) {
  const eventEmitter = new EventEmitterLike()

  /**
   * Caches the init data until the video ends
   * that way changing qualities and between audio and DASH
   * doesn't have to fetch the init data and segment index again
   * @type {Map<string, Uint8Array>}
   */
  const initDataCache = new Map()

  /**
   * Mutable so that credentials can be swapped underneath a running player
   * without destroying it, see `refresh` below.
   */
  const credentials = {
    poToken: base64ToU8(sabrData.poToken),
    videoPlaybackUstreamerConfig: base64ToU8(sabrData.ustreamerConfig),
    clientInfo: deepCopy(sabrData.clientInfo),
  }

  /**
   * While a credential refresh is in flight, requests park on this promise
   * instead of failing. Null means no refresh is in progress.
   * @type {?PendingRefresh}
   */
  let pendingRefresh = null

  /**
   * Set once this session has been cleaned up. Everything still in flight then
   * belongs to a player that no longer exists, so it must fail quietly rather
   * than ask for a recovery nobody wanted.
   */
  let tornDown = false

  function beginRefresh() {
    if (pendingRefresh) return

    let promiseResolve
    let promiseReject
    const promise = new Promise((resolve, reject) => {
      promiseResolve = resolve
      promiseReject = reject
    })
    // If every parked request is cancelled before an abandoned refresh
    // rejects, nobody is awaiting: swallow the unhandled rejection
    promise.catch(() => {})
    pendingRefresh = { promise, resolve: promiseResolve, reject: promiseReject }
  }

  /**
   * Incremented on every refresh. A request built before a refresh carries the
   * old generation, which is how we know its playback cookie is dead.
   */
  let sessionGeneration = 0

  /**
   * Re-applies current credentials to a request immediately before encoding.
   * The request body is built once when the Shaka request arrives and
   * re-encoded from the same object on every retry, so mutable credentials
   * alone are not enough: a request that parks across a refresh would still
   * send the old PO token, which the new session answers with a 403.
   * @param {VideoPlaybackAbrRequest} abrRequest
   * @param {number} builtAtGeneration
   */
  function applyCredentials(abrRequest, builtAtGeneration) {
    abrRequest.streamerContext.poToken = credentials.poToken
    abrRequest.streamerContext.clientInfo = credentials.clientInfo
    abrRequest.videoPlaybackUstreamerConfig = credentials.videoPlaybackUstreamerConfig

    if (builtAtGeneration !== sessionGeneration) {
      // The cookie identifies the dead session; sending it to the new one is
      // worse than sending nothing. The backoff echo belongs to it too.
      abrRequest.streamerContext.playbackCookie = undefined
      abrRequest.streamerContext.backoffTimeMs = undefined
    }

    return sessionGeneration
  }

  const sessionStartedAt = Date.now()

  /** @type {SabrStreamState} */
  const sabrStreamState = {
    sabrUrl: sabrData.url,
    activeSabrContextTypes: new Set(),
    sabrContexts: new Map(),
    nextRequestPolicy: undefined,
    playerReloadRequested: false,
    requestNumber: 0,
    refreshInFlight: false,
    hasServedMedia: false,
  }

  /**
   * Answers one Shaka request from this session. The regulator hands these to
   * whichever session it is serving from, so a request that arrives here is
   * already this session's to answer.
   * @type {shaka.extern.SchemePlugin}
   */
  function handleRequest(uri, request, requestType, _progressUpdated, headersReceived, _config) {
    // lazily fetch it as the variable is only set after the session is created
    // but it will definitely exist when we receive a request here.
    const player = getPlayer()
    if (player == null) {
      // This is true during reload, returning a promise to suppress error
      return new AbortableOperation(Promise.resolve())
    }
    const isAudioOnly = player.isAudioOnly()

    const url = new URL(request.uris[0])

    const isInit = url.searchParams.has('init')
    const formatIdString = url.searchParams.get('formatId')

    if (isInit && initDataCache.has(formatIdString)) {
      return /** @__NOINLINE__ */ createCacheResponse(uri, request, initDataCache.get(formatIdString))
    }

    const variantTracks = player.getVariantTracks()
    const activeVariant = variantTracks.find(track => track.active)

    const streamIsAudio = url.pathname === 'audio'
    const streamIsVideo = url.pathname === 'video'

    let audioFormatId
    let videoFormatId

    if (streamIsAudio) {
      audioFormatId = formatIdFromString(formatIdString)

      if (isAudioOnly) {
        // We need to specify a video format even for audio only otherwise we get an error response
        videoFormatId = formatIdFromString(url.searchParams.get('videoFormatId'))
      } else {
        videoFormatId = formatIdFromString((activeVariant ?? variantTracks[0]).originalVideoId)
      }
    } else if (streamIsVideo) {
      videoFormatId = formatIdFromString(formatIdString)

      // for the first fetching of the initial data there won't be an active variant
      // (shaka-player only sets it to active after it has fetched the init/segment data)
      if (activeVariant) {
        audioFormatId = formatIdFromString(activeVariant.originalAudioId)
      } else {
        const candidates = variantTracks.filter((track) => track.audioRoles.includes('main'))

        const probableAudioFormat = candidates.reduce((previous, current) => {
          return current.audioBandwidth >= previous.audioBandwidth ? current : previous
        }, candidates[0])

        audioFormatId = formatIdFromString(probableAudioFormat.originalAudioId)
      }
    }

    /** @type {import('googlevideo/protos').BufferedRange[]} */
    const bufferedRanges = []

    if (!isInit && activeVariant) {
      /** @__NOINLINE__ */ fillBufferedRanges(player, getManifest(), isAudioOnly, streamIsVideo, streamIsAudio, bufferedRanges, activeVariant)
    }

    let playerTimeMs = '0'

    if (url.searchParams.has('startTimeMs')) {
      playerTimeMs = url.searchParams.get('startTimeMs')
    }

    const drcEnabled = url.searchParams.has('drc') || !!(activeVariant && activeVariant.audioRoles.includes('drc'))
    const enableVoiceBoost = url.searchParams.has('vb') || !!(activeVariant && activeVariant.audioRoles.includes('vb'))

    const resolution = streamIsVideo ? parseInt(url.searchParams.get('resolution')) : undefined

    const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(sabrStreamState)

    /** @type {VideoPlaybackAbrRequest} */
    const requestData = {
      clientAbrState: {
        bandwidthEstimate: String(Math.round(player.getStats().estimatedBandwidth)),
        timeSinceLastManualFormatSelectionMs: streamIsVideo ? '0' : undefined,
        stickyResolution: resolution,
        lastManualSelectedResolution: resolution,
        playbackRate: player.getPlaybackRate(),
        enabledTrackTypesBitfield: streamIsAudio ? 1 : 0,
        drcEnabled,
        enableVoiceBoost,
        playerTimeMs,
        clientViewportWidth: playerWidth.value,
        clientViewportHeight: playerHeight.value,
        clientViewportIsFlexible: false
      },
      selectedAudioFormatIds: [audioFormatId],
      selectedVideoFormatIds: [videoFormatId],
      selectedCaptionFormatIds: [],
      initializationFormatIds: isInit ? [] : [audioFormatId, videoFormatId],
      bufferedRanges,
      streamerContext: {
        poToken: credentials.poToken,
        clientInfo: credentials.clientInfo,
        sabrContexts,
        unsentSabrContexts,
        playbackCookie: sabrStreamState.nextRequestPolicy?.playbackCookie,
      },
      ssapPlaybackInfos: [],
      field1000: [],
      videoPlaybackUstreamerConfig: credentials.videoPlaybackUstreamerConfig,
    }

    let body

    try {
      body = VideoPlaybackAbrRequest.encode(requestData).finish()
    } catch (error) {
      console.error('Invalid VideoPlaybackAbrRequest data', requestData)
      throw error
    }

    const sequenceNumber = parseInt(url.searchParams.get('sq'))

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {OperationInputs}
     */
    const opInputs = {
      uri,
      request,
      requestType,
      headersReceived,

      formatIdString,
      isInit,
      sequenceNumber,
    }

    const abortController = new AbortController()

    /** @type {RequestInit} */
    const init = {
      body,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump',
      },
      signal: abortController.signal,
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {AbortStatus}
     */
    const abortStatus = {
      cancelled: false,
      timedOut: false,
      finished: false,
    }

    const timeoutMs = request.retryParameters.timeout
    let timeoutController = null
    if (timeoutMs) {
      timeoutController = createTimeoutController(() => {
        abortStatus.timedOut = true
        abortController.abort()
      }, timeoutMs)
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {CurrentState}
     */
    const currentState = {
      initDataCache,
      abrRequest: requestData,
      requestInit: init,
      abortStatus: abortStatus,
      abortController,
      sabrStreamState,
      timeoutController,
      eventEmitter,
      cumulativeBackOffTimeMs: 0,
      cumulativeBackOffRequested: 0,
      cumulativeRetryDueToNextRequestPolicy: 0,
      loopSuspicionLogged: false,
      generation: sessionGeneration,
      recovery,
      applyCredentials,
      getPendingRefresh: () => pendingRefresh,
      beginRefresh,
      sessionStartedAt,
      isTornDown: () => tornDown,
    }

    const pendingRequest = doRequest(opInputs, currentState)

    const op = new AbortableOperation(pendingRequest, () => {
      abortStatus.cancelled = true
      abortController.abort()
      return Promise.resolve()
    })

    if (timeoutController) {
      op.finally(() => {
        timeoutController.clearTimeout()
      })
    }

    return op
  }

  const cleanup = () => {
    tornDown = true

    initDataCache.clear()

    // Release anything still parked, so requests cannot outlive the player
    const refresh = pendingRefresh
    pendingRefresh = null
    refresh?.reject(new Error('SABR session cleaned up during refresh'))
  }

  return {
    handleRequest,
    onBackoffRequested(callback) {
      eventEmitter.on('backoff-requested', callback)
    },
    /**
     * Fires when this session is finished and only reloading the watch page
     * is left. The payload names what asked for it, so the toast the viewer
     * sees can say so.
     * @param {(payload: { reason: string }) => void} callback
     */
    onReloadOnce(callback) {
      eventEmitter.once('reload', callback)
    },
    /**
     * Fires when the server has stopped serving media for the current PO
     * token and fresh credentials are needed. The consumer answers with
     * either `refresh` or `abandonRefresh`. Not `once`: a session can need
     * refreshing more than once.
     * @param {() => void} callback
     */
    onRefreshNeeded(callback) {
      eventEmitter.on('refresh-needed', callback)
    },
    /**
     * Fires when refreshing credentials underneath the running session has
     * stopped being worth it and the session should be rebuilt from scratch,
     * keeping the watch page. This session is finished either way: the
     * consumer either rebuilds it or falls back to reloading the page.
     * @param {(payload: { reason: string }) => void} callback
     */
    onHardReloadNeededOnce(callback) {
      eventEmitter.once('hard-reload-needed', callback)
    },
    /**
     * Swaps in fresh credentials without tearing down the player. Protocol
     * state tied to the old streaming session is discarded; the init data
     * cache is kept because the caller has verified the formats are
     * unchanged.
     * @param {import('../../views/Watch/Watch').SabrData} newSabrData
     */
    refresh(newSabrData) {
      noteCredentialsInstalled()

      credentials.poToken = base64ToU8(newSabrData.poToken)
      credentials.videoPlaybackUstreamerConfig = base64ToU8(newSabrData.ustreamerConfig)
      credentials.clientInfo = deepCopy(newSabrData.clientInfo)

      sabrStreamState.sabrUrl = newSabrData.url
      sabrStreamState.activeSabrContextTypes.clear()
      sabrStreamState.sabrContexts.clear()
      sabrStreamState.nextRequestPolicy = undefined
      sabrStreamState.playerReloadRequested = false
      sabrStreamState.requestNumber = 0
      sabrStreamState.refreshInFlight = false

      // Must precede the release below so parked requests observe the new
      // generation and rebuild their bodies against the new credentials
      sessionGeneration += 1

      const refresh = pendingRefresh
      pendingRefresh = null
      refresh?.resolve()
    },
    /**
     * Aborts a refresh that could not complete. Parked requests reject and
     * fall back to the full player reload.
     * @param {Error} error its message is the reason the viewer is shown, so
     * it says what went wrong rather than that something did
     */
    abandonRefresh(error) {
      sabrStreamState.refreshInFlight = false

      const refresh = pendingRefresh
      pendingRefresh = null
      refresh?.reject(error)
    },
    /**
     * Format identifiers this session has served init data for. The caller
     * compares them against a fresh player response to decide whether the
     * existing buffer survives a refresh.
     * @returns {string[]}
     */
    getFormatIds() {
      return [...initDataCache.keys()]
    },
    cleanup,
  }
}
