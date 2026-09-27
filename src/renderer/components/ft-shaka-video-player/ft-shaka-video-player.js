import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import shaka from 'shaka-player'
import { useI18n } from 'vue-i18n'

import store from '../../store/index'
import { KeyboardShortcuts } from '../../../constants'
import { AudioTrackSelection } from './player-components/AudioTrackSelection'
import { FullWindowButton } from './player-components/FullWindowButton'
import { LegacyQualitySelection } from './player-components/LegacyQualitySelection'
import { PinControlsButton } from './player-components/PinControlsButton'
import { ScreenshotButton } from './player-components/ScreenshotButton'
import { StatsButton } from './player-components/StatsButton'
import { TheatreModeButton } from './player-components/TheatreModeButton'
import { AutoplayToggle } from './player-components/AutoplayToggle'
import { SkipButton } from './player-components/SkipButton'
import { VolumeBar } from './player-components/VolumeBar'
import {
  deduplicateAudioTracks,
  findMostSimilarAudioBandwidth,
  getSponsorBlockSegments,
  logShakaError,
  repairInvidiousManifest,
  translateSponsorBlockCategory
} from '../../helpers/player/utils'
import {
  addKeyboardShortcutToActionTitle,
  showToast,
  writeFileWithPicker,
  throttle,
  debounce,
  removeFromArrayIfExists,
  copyToClipboard,
} from '../../helpers/utils'
import { AudioGainStage, loudnessDbToGain } from '../../helpers/player/audioGain'
import { MANIFEST_TYPE_SABR } from '../../helpers/player/SabrManifestParser'
import { sabrWallInjectionEnabled, shouldAbandonRefresh } from '../../helpers/player/sabrWallInjection'

/** @typedef {import('../../helpers/sponsorblock').SponsorBlockCategory} SponsorBlockCategory */

/**
 * Everything the volume bar needs from the component that owns the video element.
 * @typedef {object} VolumeState
 * @property {number} maxPercent the ceiling of the volume range, in percent
 * @property {number} basePercent the volume the user asked for, in percent
 * @property {number} normalizationGain this video's loudness correction
 * @property {number} gain the amplification currently applied past 100%
 * @property {(percent: number) => void} setBasePercent
 * @property {(gain: number) => void} setGain
 */

// The UTF-8 characters "h", "t", "t", and "p".
const HTTP_IN_HEX = 0x68747470

const USE_OVERFLOW_MENU_WIDTH_THRESHOLD = 634

/**
 * How much a keyboard shortcut or a scroll over the player changes the volume by,
 * in dB. Two dB is a small but clearly audible step, and crosses the default
 * range of the volume bar in about 30 presses.
 */
const VOLUME_STEP_DB = 2

const RequestType = shaka.net.NetworkingEngine.RequestType
const AdvancedRequestType = shaka.net.NetworkingEngine.AdvancedRequestType
const TrackLabelFormat = shaka.ui.Overlay.TrackLabelFormat
const { Severity: ErrorSeverity, Category: ErrorCategory, Code: ErrorCode } = shaka.util.Error

/**
 * How many times running we let shaka-player's own recovery keep the video
 * before we stop standing aside for it.
 *
 * It resets the media source and carries on, but nothing in shaka bounds how
 * often: `resetMediaSource(force)` skips its own `minTimeBetweenRecoveries`
 * when the streaming engine calls it for a failed append. A segment that is
 * rejected every time it is fetched would otherwise cycle forever, which is a
 * worse outcome for the viewer than the format fallback they used to get.
 */
const SHAKA_HANDLED_ERROR_LIMIT = 3

/**
 * A failure this long after the previous one is a fresh incident rather than a
 * loop, so the count above starts over. One bad segment every few minutes is
 * exactly what we want to keep absorbing; several within seconds is the loop.
 */
const SHAKA_HANDLED_ERROR_WINDOW_MS = 30_000

/*
  Mapping of Shaka localization keys for control labels to FreeTube shortcuts.
  See: https://github.com/shaka-project/shaka-player/blob/main/ui/locales/en.json
*/
const shakaControlKeysToShortcuts = {
  MUTE: KeyboardShortcuts.VIDEO_PLAYER.GENERAL.MUTE,
  UNMUTE: KeyboardShortcuts.VIDEO_PLAYER.GENERAL.MUTE,
  PLAY: KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.PLAY,
  PAUSE: KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.PLAY,
  PICTURE_IN_PICTURE: KeyboardShortcuts.VIDEO_PLAYER.GENERAL.PICTURE_IN_PICTURE,
  ENTER_PICTURE_IN_PICTURE: KeyboardShortcuts.VIDEO_PLAYER.GENERAL.PICTURE_IN_PICTURE,
  EXIT_PICTURE_IN_PICTURE: KeyboardShortcuts.VIDEO_PLAYER.GENERAL.PICTURE_IN_PICTURE,
  CAPTIONS: KeyboardShortcuts.VIDEO_PLAYER.GENERAL.CAPTIONS,
  FULL_SCREEN: KeyboardShortcuts.VIDEO_PLAYER.GENERAL.FULLSCREEN,
  EXIT_FULL_SCREEN: KeyboardShortcuts.VIDEO_PLAYER.GENERAL.FULLSCREEN
}

/** @type {Map<string, string>} */
const LOCALE_MAPPINGS = new Map(process.env.SHAKA_LOCALE_MAPPINGS)

export default defineComponent({
  name: 'FtShakaVideoPlayer',
  props: {
    format: {
      type: String,
      required: true
    },
    manifestSrc: {
      type: String,
      default: null
    },
    manifestMimeType: {
      type: String,
      required: true
    },
    sabrData: {
      type: Object,
      default: null
    },
    /**
     * The watch view's SABR regulator. It owns the `sabr://` scheme slot and
     * every recovery decision, and it belongs to the view rather than to us
     * because reloading this player is one of the remedies it can choose.
     * @type {import('vue').PropType<import('../../helpers/player/SabrRegulator').SabrRegulator>}
     */
    sabrRegulator: {
      type: Object,
      default: null
    },
    legacyFormats: {
      type: Array,
      default: () => ([])
    },
    startTime: {
      type: Number,
      default: null
    },
    captions: {
      type: Array,
      default: () => ([])
    },
    chapters: {
      type: Array,
      default: () => ([])
    },
    currentChapterIndex: {
      type: Number,
      default: 0
    },
    chaptersSrc: {
      type: String,
      default: ''
    },
    storyboardSrc: {
      type: String,
      default: ''
    },
    videoId: {
      type: String,
      default: ''
    },
    channelId: {
      type: String,
      default: ''
    },
    title: {
      type: String,
      default: ''
    },
    thumbnail: {
      type: String,
      default: ''
    },
    theatrePossible: {
      type: Boolean,
      default: false
    },
    useTheatreMode: {
      type: Boolean,
      default: false
    },
    autoplayPossible: {
      type: Boolean,
      default: false
    },
    autoplayEnabled: {
      type: Boolean,
      default: false
    },
    watchingPlaylist: {
      type: Boolean,
      default: false
    },
    vrProjection: {
      type: String,
      default: null
    },
    startInFullscreen: {
      type: Boolean,
      default: false
    },
    startInFullwindow: {
      type: Boolean,
      default: false
    },
    startInPip: {
      type: Boolean,
      default: false
    },
    currentPlaybackRate: {
      type: Number,
      default: 1
    },
    delayLoadUntilUnix: {
      type: Number,
      default: 0
    },
    /**
     * How much louder this video is than YouTube's reference loudness, in dB.
     * `null` when unknown, which is always the case for Invidious as it never
     * reports it. `0` is a legitimate value, so never test this for truthiness.
     */
    loudnessDb: {
      type: Number,
      default: null
    },
    /**
     * Which platform the video comes from. Anything but `'youtube'` switches
     * off the behaviour that only makes sense for YouTube videos.
     */
    platform: {
      type: String,
      default: 'youtube'
    },
  },
  emits: [
    'error',
    'loaded',
    'ended',
    'timeupdate',
    'toggle-autoplay',
    'toggle-theatre-mode',
    'playback-rate-updated',
    'skip-to-next',
    'skip-to-prev',
    'player-reload-requested',
    'sabr-refresh-requested',
  ],
  setup: function (props, { emit, expose }) {
    const { locale, t } = useI18n()

    /** @type {shaka.Player|null} */
    let player = null

    /** @type {shaka.ui.Overlay|null} */
    let ui = null

    const events = new EventTarget()

    /** @type {import('vue').Ref<HTMLDivElement | null>} */
    const container = ref(null)

    /** @type {import('vue').Ref<HTMLVideoElement | null>} */
    const video = ref(null)

    /** @type {import('vue').Ref<HTMLCanvasElement | null>} */
    const vrCanvas = ref(null)

    const hasLoaded = ref(false)

    const hasMultipleAudioTracks = ref(false)
    const isLive = ref(false)

    const onlyUseOverFlowMenu = ref(false)
    const forceAspectRatio = ref(false)

    const activeLegacyFormat = shallowRef(null)

    const fullWindowEnabled = ref(false)
    const startInFullwindow = props.startInFullwindow
    let startInFullscreen = props.startInFullscreen
    let startInPip = props.startInPip

    /** @type {number|null} */
    let restoreCaptionIndex = null

    if (store.getters.getEnableSubtitlesByDefault && props.captions.length > 0) {
      restoreCaptionIndex = 0
    }

    const showStats = ref(false)
    const stats = reactive({
      resolution: {
        width: 0,
        height: 0,
        frameRate: 0
      },
      bitrate: '0',
      volume: '100',
      bandwidth: '0',
      buffered: '0',
      frames: {
        totalFrames: 0,
        droppedFrames: 0
      },
      codecs: {
        audioItag: '',
        audioCodec: '',
        videoItag: '',
        videoCodec: ''
      }
    })

    const playerDimensions = computed(() => ({
      width: playerWidth.value,
      height: playerHeight.value
    }))

    /**
     * The loudness correction for this video as a percentage, for the stats overlay.
     * `null` when the video's loudness is unknown.
     * @type {import('vue').ComputedRef<string|null>}
     */
    const normalizationPercentage = computed(() => {
      if (props.loudnessDb == null) {
        return null
      }

      return (loudnessDbToGain(props.loudnessDb) * 100).toFixed(1)
    })

    // #region settings

    /** @type {import('vue').ComputedRef<boolean>} */
    const autoplayVideos = computed(() => {
      return store.getters.getAutoplayVideos
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const displayVideoPlayButton = computed(() => {
      return store.getters.getDisplayVideoPlayButton
    })

    watch(displayVideoPlayButton, (newValue) => {
      ui.configure({
        bigButtons: newValue ? ['play_pause_buffering'] : [],
        showBufferingSpinner: !newValue
      })
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const pinPlayerControls = computed(() => {
      return store.getters.getPinPlayerControls
    })

    watch(pinPlayerControls, (newValue) => {
      if (!ui) {
        return
      }

      // shaka's `showUIAlways` stops both the fade and the mouse-still timer
      // from hiding the controls. Reconfiguring rebuilds them, which is also
      // what gives the pin button its new state.
      ui.configure({
        showUIAlways: newValue
      })

      // Pinning while the controls are hidden has to bring them up, since
      // shaka only stops hiding them and never shows them for this. Unpinning
      // has to restart the mouse-still timer, which shaka stopped rearming
      // while pinned, or the controls stay up until the mouse next moves.
      showOverlayControls()

      // showing the controls also shows the cursor, so arm the timer that
      // hides it again (or, when unpinning, disarm it and leave that to shaka)
      hideCursorWhenStillWhilePinned()
    })

    /**
     * shaka hides the cursor from the same mouse-still callback that hides the
     * controls, and `showUIAlways` returns from it before either happens. Left
     * at that, pinning the controls would pin the cursor over the video too, so
     * the cursor gets its own timer while the controls are pinned, matching
     * shaka's three seconds.
     */
    const PINNED_CURSOR_HIDE_DELAY_MS = 3000

    /** @type {number | null} */
    let pinnedCursorTimeout = null

    function clearPinnedCursorTimeout() {
      if (pinnedCursorTimeout !== null) {
        clearTimeout(pinnedCursorTimeout)
        pinnedCursorTimeout = null
      }
    }

    function hideCursorWhenStillWhilePinned() {
      clearPinnedCursorTimeout()

      if (!pinPlayerControls.value) {
        return
      }

      pinnedCursorTimeout = setTimeout(() => {
        pinnedCursorTimeout = null
        container.value?.classList.add('no-cursor')
      }, PINNED_CURSOR_HIDE_DELAY_MS)
    }

    /** @type {import('vue').ComputedRef<number>} */
    const defaultSkipInterval = computed(() => {
      return store.getters.getDefaultSkipInterval
    })

    watch(defaultSkipInterval, (newValue) => {
      ui.configure({
        tapSeekDistance: newValue
      })
    })

    /** @type {import('vue').ComputedRef<number | 'auto'>} */
    const defaultQuality = computed(() => {
      const value = store.getters.getDefaultQuality

      // TODO: Revert when auto is fixed (720 is the default setttings value)
      if (value === 'auto') { return 720 }
      // if (value === 'auto') { return value }

      return parseInt(value)
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const enterFullscreenOnDisplayRotate = computed(() => {
      return store.getters.getEnterFullscreenOnDisplayRotate
    })

    watch(enterFullscreenOnDisplayRotate, (newValue) => {
      ui.configure({
        enableFullscreenOnRotation: newValue
      })
    })

    /** @type {import('vue').ComputedRef<number>} */
    const defaultPlaybackRate = computed(() => {
      return store.getters.getDefaultPlayback
    })

    watch(defaultPlaybackRate, (newValue) => {
      if (video.value) {
        video.value.defaultPlaybackRate = newValue
      }
    })

    const maxVideoPlaybackRate = computed(() => {
      return parseInt(store.getters.getMaxVideoPlaybackRate)
    })

    watch(maxVideoPlaybackRate, (newValue) => {
      ui.configure({
        playbackRateSliderMax: newValue
      })
    })

    const videoPlaybackRateInterval = computed(() => {
      return parseFloat(store.getters.getVideoPlaybackRateInterval)
    })

    /** @type {import('vue').ComputedRef<number>} */
    const maxVolume = computed(() => {
      return store.getters.getMaxVolume
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const normalizeLoudness = computed(() => {
      return store.getters.getNormalizeLoudness
    })

    /**
     * How much this video's volume has to be multiplied by to bring it to
     * YouTube's reference loudness. 1 when the correction is turned off or the
     * video's loudness is unknown.
     * @type {import('vue').ComputedRef<number>}
     */
    const normalizationGain = computed(() => {
      if (!normalizeLoudness.value || props.loudnessDb == null) {
        return 1
      }

      return loudnessDbToGain(props.loudnessDb)
    })

    /**
     * The presets offered beside shaka's playback rate slider.
     *
     * Half steps, and deliberately not the viewer's playback rate interval.
     * shaka 5.2 turned this menu from a plain list into a slider with presets
     * beside it, which is a different thing than the list was: a preset is a
     * place worth jumping to, so a handful of round numbers serve, while the
     * interval is how far one keypress moves. Driving the presets from the
     * interval conflates the two, and it does not degrade gracefully -- an
     * interval of 0.1 with a maximum of 10 asks for a hundred of them.
     *
     * The interval keeps its own job, stepping the rate for the increase and
     * decrease shortcuts, where it means what it says.
     *
     * The maximum is honoured, so raising it offers more presets rather than
     * silently capping them. 1 is always among them, since half steps from a
     * half include it, and returning to normal speed has to stay one click
     * away.
     */
    const playbackRates = computed(() => {
      const PRESET_STEP = 0.5
      const playbackRates = []

      for (let rate = PRESET_STEP; rate <= maxVideoPlaybackRate.value; rate += PRESET_STEP) {
        playbackRates.push(rate)
      }

      return playbackRates
    })

    watch(playbackRates, (newValue) => {
      ui.configure({
        playbackRates: newValue
      })
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const enableScreenshot = computed(() => {
      return store.getters.getEnableScreenshot
    })

    /** @type {import('vue').ComputedRef<string>} */
    const screenshotMode = computed(() => {
      return store.getters.getScreenshotMode
    })

    /** @type {import('vue').ComputedRef<string>} */
    const screenshotFormat = computed(() => {
      return store.getters.getScreenshotFormat
    })

    /** @type {import('vue').ComputedRef<number>} */
    const screenshotQuality = computed(() => {
      return store.getters.getScreenshotQuality
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const videoVolumeMouseScroll = computed(() => {
      return store.getters.getVideoVolumeMouseScroll
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const videoPlaybackRateMouseScroll = computed(() => {
      return store.getters.getVideoPlaybackRateMouseScroll
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const videoSkipMouseScroll = computed(() => {
      return store.getters.getVideoSkipMouseScroll
    })

    /** @type {import('vue').ComputedRef<any[]>} */
    const sponsorBlockExcludedChannels = computed(() => {
      return JSON.parse(store.getters.getSponsorBlockExcludedChannels)
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const useSponsorBlock = computed(() => {
      // SponsorBlock only knows YouTube video ids, so it is never asked about another platform's
      return props.platform === 'youtube' && store.getters.getUseSponsorBlock
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const shouldSkipSponsorBlockSegmentsOnChannel = computed(() => {
      return useSponsorBlock.value && !sponsorBlockExcludedChannels.value.some(c => c.name === props.channelId)
    })

    /** @type {import('vue').ComputedRef<boolean>} */
    const sponsorBlockShowSkippedToast = computed(() => {
      return store.getters.getSponsorBlockShowSkippedToast
    })

    const sponsorSkips = computed(() => {
      // save some work when sponsorblock is disabled
      if (!useSponsorBlock.value) {
        return {}
      }

      /** @type {SponsorBlockCategory[]} */
      const sponsorCategories = ['sponsor',
        'selfpromo',
        'interaction',
        'intro',
        'outro',
        'preview',
        'music_offtopic',
        'filler'
      ]

      /** @type {Set<SponsorBlockCategory>} */
      const autoSkip = new Set()

      /** @type {SponsorBlockCategory[]} */
      const seekBar = []

      /** @type {Set<SponsorBlockCategory>} */
      const promptSkip = new Set()

      /**
       * @type {{
       *   [key in SponsorBlockCategory]: {
       *     color: string,
       *     skip: 'autoSkip' | 'promptToSkip' | 'showInSeekBar' | 'doNothing'
       *   }
        }} */
      const categoryData = {}

      sponsorCategories.forEach(x => {
        let sponsorVal = {}
        switch (x) {
          case 'sponsor':
            sponsorVal = store.getters.getSponsorBlockSponsor
            break
          case 'selfpromo':
            sponsorVal = store.getters.getSponsorBlockSelfPromo
            break
          case 'interaction':
            sponsorVal = store.getters.getSponsorBlockInteraction
            break
          case 'intro':
            sponsorVal = store.getters.getSponsorBlockIntro
            break
          case 'outro':
            sponsorVal = store.getters.getSponsorBlockOutro
            break
          case 'preview':
            sponsorVal = store.getters.getSponsorBlockRecap
            break
          case 'music_offtopic':
            sponsorVal = store.getters.getSponsorBlockMusicOffTopic
            break
          case 'filler':
            sponsorVal = store.getters.getSponsorBlockFiller
            break
        }

        if (sponsorVal.skip !== 'doNothing') {
          seekBar.push(x)
        }

        if (sponsorVal.skip === 'autoSkip') {
          autoSkip.add(x)
        }

        if (sponsorVal.skip === 'promptToSkip') {
          promptSkip.add(x)
        }

        categoryData[x] = sponsorVal
      })
      return { autoSkip, seekBar, promptSkip, categoryData }
    })

    // #endregion settings

    // #region SponsorBlock

    /**
     * @type {{
     *   uuid: string
     *   category: SponsorBlockCategory
     *   startTime: number,
     *   endTime: number
     * }[]}
     */
    let sponsorBlockSegments = []
    let sponsorBlockAverageVideoDuration = 0

    /**
     * Yes a map would be much more suitable for this (unlike objects they retain the order that items were inserted),
     * but Vue 2 doesn't support reactivity on Maps, so we have to use an array instead
     * @type {import('vue').Ref<{uuid: string, translatedCategory: string, timeoutId: number}[]>}
     */
    const skippedSponsorBlockSegments = ref([])

    async function setupSponsorBlock() {
      let segments, averageDuration

      try {
        ({ segments, averageDuration } = await getSponsorBlockSegments(props.videoId, sponsorSkips.value.seekBar))
      } catch (e) {
        console.error(e)
        segments = []
      }

      // check if the component is already getting destroyed
      // which is possible because this function runs asynchronously
      if (!ui || !player) {
        return
      }

      if (segments.length > 0) {
        sponsorBlockSegments = segments
        sponsorBlockAverageVideoDuration = averageDuration

        createSponsorBlockMarkers(averageDuration)
      }
    }

    /**
     * @param {number} currentTime
     */
    function skipSponsorBlockSegments(currentTime) {
      if (!shouldSkipSponsorBlockSegmentsOnChannel.value) {
        return
      }

      const { autoSkip } = sponsorSkips.value

      if (autoSkip.size === 0) {
        return
      }

      const video_ = video.value

      let newTime = 0
      const skippedSegments = []

      sponsorBlockSegments.forEach(segment => {
        if (autoSkip.has(segment.category) && currentTime < segment.endTime &&
          (segment.startTime <= currentTime ||
            // if we already have a segment to skip, check if there are any that are less than 150ms later,
            // so that we can skip them all in one go (especially useful on slow connections)
            (newTime > 0 && (segment.startTime < newTime || segment.startTime - newTime <= 0.150) && segment.endTime > newTime))) {
          newTime = segment.endTime
          skippedSegments.push(segment)
        }
      })

      if (newTime === 0 || video_.ended) {
        return
      }

      const videoEnd = player.seekRange().end

      if (Math.abs(videoEnd - currentTime) < 1 || video_.ended) {
        return
      }

      if (newTime > videoEnd || Math.abs(videoEnd - newTime) < 1) {
        newTime = videoEnd
      }

      video_.currentTime = newTime

      if (sponsorBlockShowSkippedToast.value) {
        skippedSegments.forEach(({ uuid, category }) => {
          // if the element already exists, just update the timeout, instead of creating a duplicate
          // can happen at the end of the video sometimes
          const existingSkip = skippedSponsorBlockSegments.value.find(skipped => skipped.uuid === uuid)
          if (existingSkip) {
            clearTimeout(existingSkip.timeoutId)

            existingSkip.timeoutId = setTimeout(() => {
              const index = skippedSponsorBlockSegments.value.findIndex(skipped => skipped.uuid === uuid)
              skippedSponsorBlockSegments.value.splice(index, 1)
            }, 2000)
          } else {
            skippedSponsorBlockSegments.value.push({
              uuid,
              translatedCategory: translateSponsorBlockCategory(category),
              timeoutId: setTimeout(() => {
                const index = skippedSponsorBlockSegments.value.findIndex(skipped => skipped.uuid === uuid)
                skippedSponsorBlockSegments.value.splice(index, 1)
              }, 2000)
            })
          }
        })
      }
    }

    // #endregion SponsorBlock

    // #region player config

    const seekingIsPossible = computed(() => {
      if (props.manifestMimeType !== 'application/x-mpegurl') {
        return true
      }

      // The duration rule below reads YouTube's HLS URLs. Other platforms' HLS
      // is seekable, and shaka keeps a live stream within its seek range itself.
      if (props.platform !== 'youtube') {
        return true
      }

      if (!props.manifestSrc) {
        return false
      }

      const match = props.manifestSrc.match(/\/(?:manifest|playlist)_duration\/(\d+)\//)

      // Check how many seconds we are allowed to seek, 30 is too short, 3600 is an hour which is great
      return match != null && parseInt(match[1] || '0') > 30
    })

    /**
     * @param {'dash'|'audio'|'legacy'} format
     * @param {boolean} useAutoQuality
     * @returns {shaka.extern.PlayerConfiguration}
     */
    function getPlayerConfig(format, useAutoQuality = false) {
      return {
        // YouTube uses these values and they seem to work well in FreeTube too,
        // so we might as well use them
        streaming: {
          bufferingGoal: 180,
          rebufferingGoal: 0.02,
          bufferBehind: 300
        },
        manifest: {
          disableVideo: format === 'audio',

          // makes captions work for live streams and doesn't seem to have any negative affect on VOD videos
          segmentRelativeVttTiming: true,
          dash: {
            manifestPreprocessorTXml: manifestPreprocessorTXml
          },
        },
        abr: {
          enabled: useAutoQuality,

          // This only affects the "auto" quality, users can still manually select whatever quality they want.
          restrictToElementSize: true
        },

        // Prioritise variants that are predicted to play:
        // - `smooth`: without dropping frames
        // - `powerEfficient` the spec is quite vague but in Chromium it should prioritise hardware decoding when available
        // https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo
        preferredDecodingAttributes: format === 'dash' ? ['smooth', 'powerEfficient'] : [],

        // Electron doesn't like YouTube's vp9 VR video streams and throws:
        // "CHUNK_DEMUXER_ERROR_APPEND_FAILED: Projection element is incomplete; ProjectionPoseYaw required."
        // So use the AV1 and h264 codecs instead which it doesn't reject
        preferredVideo: typeof props.vrProjection === 'string' ? [{ codec: 'av01' }, { codec: 'avc1' }] : []
      }
    }

    /**
     * @param {shaka.extern.xml.Node} mpdNode
     */
    function manifestPreprocessorTXml(mpdNode) {
      /** @type {shaka.extern.xml.Node[]} */
      const periods = mpdNode.children?.filter(child => typeof child !== 'string' && child.tagName === 'Period') ?? []

      sortAdapationSetsByCodec(periods)
      sortAudioAdaptationSetsByBitrate(periods)

      if (mpdNode.attributes.type === 'dynamic') {
        // fix live stream loading issues
        // YouTube uses a 12 second delay on the official website for normal streams
        // and a shorter one for low latency streams
        // If we don't add a little bit of a delay, we get presented with a loading symbol every 5 seconds,
        // while shaka-player processes the new manifest and segments
        const minimumUpdatePeriod = parseFloat(mpdNode.attributes.minimumUpdatePeriod.match(/^PT(\d+(?:\.\d+)?)S$/)[1])
        mpdNode.attributes.suggestedPresentationDelay = `PT${(minimumUpdatePeriod * 2).toFixed(3)}S`

        // fix live streams with subtitles having duplicate Representation ids
        // shaka-player throws DASH_DUPLICATE_REPRESENTATION_ID if we don't fix it

        for (const period of periods) {
          /** @type {shaka.extern.xml.Node[]} */
          const representations = []

          for (const periodChild of period.children) {
            if (typeof periodChild !== 'string' && periodChild.tagName === 'AdaptationSet') {
              for (const adaptationSetChild of periodChild.children) {
                if (typeof adaptationSetChild !== 'string' && adaptationSetChild.tagName === 'Representation') {
                  representations.push(adaptationSetChild)
                }
              }
            }
          }

          const knownIds = new Set()
          let counter = 0
          for (const representation of representations) {
            const id = representation.attributes.id

            if (knownIds.has(id)) {
              const newId = `${id}-ft-fix-${counter}`

              representation.attributes.id = newId
              knownIds.add(newId)
              counter++
            } else {
              knownIds.add(id)
            }
          }
        }
      } else if (!process.env.SUPPORTS_LOCAL_API) {
        repairInvidiousManifest(periods)
      }
    }

    /**
     * @param {shaka.extern.xml.Node[]} periods
     */
    function sortAdapationSetsByCodec(periods) {
      /** @param {shaka.extern.xml.Node} adaptationSet */
      const getCodecsPrefix = (adaptationSet) => {
        const codecs = adaptationSet.attributes.codecs ??
          adaptationSet.children
            .find(child => typeof child !== 'string' && child.tagName === 'Representation').attributes.codecs

        return codecs.split('.')[0]
      }

      const codecPriorities = [
        // audio
        'opus',
        'mp4a',
        'ec-3',
        'ac-3',

        // video
        'av01',
        'vp09',
        'vp9',
        'avc1'
      ]

      for (const period of periods) {
        period.children
          ?.sort((
            /** @type {shaka.extern.xml.Node | string} */ a,
            /** @type {shaka.extern.xml.Node | string} */ b
          ) => {
            if (typeof a === 'string' || a.tagName !== 'AdaptationSet' ||
              typeof b === 'string' || b.tagName !== 'AdaptationSet') {
              return 0
            }

            const typeA = a.attributes.contentType || a.attributes.mimeType.split('/')[0]
            const typeB = b.attributes.contentType || b.attributes.mimeType.split('/')[0]

            // always place image and text tracks AdaptionSets last in the manifest

            if (typeA !== 'video' && typeA !== 'audio') {
              return 1
            }
            if (typeB !== 'video' && typeB !== 'audio') {
              return -1
            }

            const codecsPrefixA = getCodecsPrefix(a)
            const codecsPrefixB = getCodecsPrefix(b)

            return codecPriorities.indexOf(codecsPrefixA) - codecPriorities.indexOf(codecsPrefixB)
          })
      }
    }

    /**
     * Sort audio AdaptationSets so that streams with higher bitrates come first.
     * Workaround that makes the player select high-quality audio.
     * @param {shaka.extern.xml.Node[]} periods
     */
    function sortAudioAdaptationSetsByBitrate(periods) {
      for (const period of periods) {
        period.children
          ?.filter(child => typeof child !== 'string' && child.tagName === 'AdaptationSet' &&
            (child.attributes.contentType === 'audio' || child.attributes.mimeType.startsWith('audio/')))
          .forEach(adaptationSet => {
            adaptationSet.children.sort((a, b) => {
              if (a.tagName === 'AudioChannelConfiguration' && b.tagName !== 'AudioChannelConfiguration') {
                // Push AudioChannelConfiguration to the front (where it seems to already be) so that it doesn't
                // block sorting Representations if it's in the middle instead
                return -1
              } else if (b.tagName === 'AudioChannelConfiguration' && a.tagName !== 'AudioChannelConfiguration') {
                return 1
              } else if (a.tagName === 'Representation' && b.tagName === 'Representation') {
                return b.attributes.bandwidth - a.attributes.bandwidth
              } else {
                return 0
              }
            })
          })
      }
    }

    // #endregion player config

    // #region UI config

    const useVrMode = computed(() => {
      return props.format === 'dash' && props.vrProjection === 'EQUIRECTANGULAR'
    })

    const uiConfig = computed(() => {
      const controlPanelElements = [
        'ft_skip_previous',
        'play_pause',
        'ft_skip_next',
        // shaka 5.2 merged its own mute and volume controls into one
        // `mute_volume` element. Not taken: the volume control here is
        // `ft_volume`, a replacement for shaka's whose travel goes past 100%
        // for the gain stage, so the merged element has nothing to merge. Both
        // `mute` and `volume` still exist in 5.2 for anyone wanting them apart.
        'mute',
        'ft_volume',
        'time_and_duration',
        'spacer'
      ]

      /** @type {shaka.extern.UIConfiguration} */
      const uiConfig = {
        controlPanelElements: controlPanelElements,
        overflowMenuButtons: [],

        // only set this to label when we actually have labels, so that the warning doesn't show up
        // about it being set to labels, but that the audio tracks don't have labels
        trackLabelFormat: hasMultipleAudioTracks.value ? TrackLabelFormat.LABEL : TrackLabelFormat.LANGUAGE_ROLE,
        // Only set it to label if we added the captions ourselves,
        // some live streams come with subtitles in the DASH manifest, but without labels
        textTrackLabelFormat: props.captions.length > 0 ? TrackLabelFormat.LABEL : TrackLabelFormat.LANGUAGE,
        displayInVrMode: useVrMode.value
      }

      /** @type {string[]} */
      let elementList

      if (onlyUseOverFlowMenu.value) {
        uiConfig.overflowMenuButtons = [
          'ft_autoplay_toggle',
          props.format === 'legacy' ? 'ft_legacy_quality' : 'quality',
          'playback_rate',
          'captions',
          'ft_audio_tracks',
          'chapter',
          'loop',
          'ft_screenshot',
          'picture_in_picture',
          'ft_full_window',
          'ft_pin_controls',
          'recenter_vr',
          'toggle_stereoscopic',
        ]

        elementList = uiConfig.overflowMenuButtons

        uiConfig.controlPanelElements.push('overflow_menu', 'fullscreen')
      } else {
        uiConfig.controlPanelElements.push(
          // first of the right-hand group, next to the spacer: the least
          // important button there, and the one that stays on screen when on
          'ft_pin_controls',
          'ft_screenshot',
          'ft_autoplay_toggle',
          'overflow_menu',
          'picture_in_picture',
          'ft_theatre_mode',
          'ft_full_window',
          'fullscreen'
        )

        uiConfig.overflowMenuButtons.push(
          'ft_audio_tracks',
          'captions',
          'playback_rate',
          props.format === 'legacy' ? 'ft_legacy_quality' : 'quality',
          'chapter',
          'loop',
          'recenter_vr',
          'toggle_stereoscopic',
        )

        elementList = uiConfig.controlPanelElements
      }

      if (!enableScreenshot.value || props.format === 'audio') {
        removeFromArrayIfExists(elementList, 'ft_screenshot')
      }

      if (!props.theatrePossible) {
        removeFromArrayIfExists(uiConfig.controlPanelElements, 'ft_theatre_mode')
      }

      if (!props.autoplayPossible) {
        removeFromArrayIfExists(elementList, 'ft_autoplay_toggle')
      }

      if (props.format === 'audio') {
        removeFromArrayIfExists(elementList, 'picture_in_picture')
        // shaka already keeps the controls up for audio only playback
        // (`showUIAlwaysOnAudioOnly`), so pinning would change nothing
        removeFromArrayIfExists(elementList, 'ft_pin_controls')
      }

      if (isLive.value) {
        removeFromArrayIfExists(uiConfig.overflowMenuButtons, 'loop')
      }

      if (!useVrMode.value) {
        removeFromArrayIfExists(uiConfig.overflowMenuButtons, 'recenter_vr')
        removeFromArrayIfExists(uiConfig.overflowMenuButtons, 'toggle_stereoscopic')
      }

      if (!props.watchingPlaylist) {
        removeFromArrayIfExists(uiConfig.controlPanelElements, 'ft_skip_previous')
        removeFromArrayIfExists(uiConfig.controlPanelElements, 'ft_skip_next')
      }

      if (props.chapters.length === 0) {
        removeFromArrayIfExists(uiConfig.overflowMenuButtons, 'chapter')
      }

      return uiConfig
    })

    /**
     * For the first call we want to set initial values for options that may change later,
     * as well as setting the options that we won't change again.
     *
     * For all subsequent calls we only want to reconfigure the options that have changed.
     * e.g. due to the active format changing or the user changing settings
     * @param {boolean} firstTime
     */
    function configureUI(firstTime = false) {
      if (firstTime) {
        /** @type {shaka.extern.UIConfiguration} */
        const firstTimeConfig = {
          addSeekBar: seekingIsPossible.value,
          customContextMenu: true,
          contextMenuElements: ['ft_stats'],
          enableTooltips: true,
          seekBarColors: {
            // shaka-player's chapter markers only show up part of the time for the DASH and audio formats
            // the issue is clearly on the FreeTube side as shaka-player's demo page works fine and they show up all the time for the legacy formats.
            // As I have spent way too much time debugging it and still cannot make sense of it, we'll stick with FreeTube's own chapter markers for now.
            chapters: 'transparent',
            played: 'var(--primary-color)'
          },
          showAudioCodec: false,
          showVideoCodec: false,
          volumeBarColors: {
            level: 'var(--primary-color)'
          },
          mediaSession: {
            // The WatchVideoInfo component handles that
            handleMetadata: false,
            // Need to override the default list so it doesn't override the next and previous video handlers in the WatchVideoPlaylist component.
            supportedActions: [
              'pause',
              'play',
              'seekbackward',
              'seekforward',
              'seekto'
            ]
          },

          // these have their own watchers
          bigButtons: displayVideoPlayButton.value ? ['play_pause_buffering'] : [],
          showBufferingSpinner: !displayVideoPlayButton.value,
          enableFullscreenOnRotation: enterFullscreenOnDisplayRotate.value,
          playbackRateSliderMax: maxVideoPlaybackRate.value,
          // the slider's lower bound is left at shaka's own default of 0.5,
          // which is where the presets start too
          playbackRates: playbackRates.value,
          tapSeekDistance: defaultSkipInterval.value,
          showUIAlways: pinPlayerControls.value,

          // we have our own ones (shaka-player's ones are quite limited)
          enableKeyboardPlaybackControls: false,

          // TODO: enable this when electron gets document PiP support
          // https://github.com/electron/electron/issues/39633
          documentPictureInPicture: {
            enabled: false
          }
        }

        if (document.pictureInPictureEnabled) {
          firstTimeConfig.mediaSession.supportedActions.push('enterpictureinpicture')
        }

        // Combine the config objects so we only need to do one configure call
        // as shaka-player recreates the UI when you call configure
        Object.assign(firstTimeConfig, uiConfig.value)

        ui.configure(firstTimeConfig)
      } else {
        ui.configure(uiConfig.value)
      }
    }

    /**
     * @param {WheelEvent} event
     */
    function handleControlsContainerWheel(event) {
      /** @type {DOMTokenList} */
      const classList = event.target.classList

      if (classList.contains('shaka-scrim-container') ||
        classList.contains('shaka-fast-forward-container') ||
        classList.contains('shaka-rewind-container') ||
        classList.contains('shaka-play-button-container') ||
        classList.contains('shaka-play-button') ||
        classList.contains('shaka-controls-container') ||
        classList.contains('shaka-spacer')) {
        //

        if (event.ctrlKey || event.metaKey) {
          if (videoPlaybackRateMouseScroll.value) {
            mouseScrollPlaybackRateHandler(event)
          }
        } else {
          if (videoVolumeMouseScroll.value) {
            mouseScrollVolumeHandler(event)
          } else if (videoSkipMouseScroll.value) {
            mouseScrollSkipHandler(event)
          }
        }
      }
    }

    /**
     * @param {MouseEvent} event
     */
    function handleControlsContainerClick(event) {
      if (event.ctrlKey || event.metaKey) {
        // stop shaka-player's click handler firing
        event.stopPropagation()

        player.cancelTrickPlay()

        showValueChange(`${defaultPlaybackRate.value}x`)
      }
    }

    function addUICustomizations() {
      /** @type {HTMLDivElement} */
      const controlsContainer = ui.getControls().getControlsContainer()

      controlsContainer.removeEventListener('wheel', handleControlsContainerWheel)
      controlsContainer.removeEventListener('click', handleControlsContainerClick, true)

      if (!useVrMode.value) {
        if (videoVolumeMouseScroll.value || videoSkipMouseScroll.value || videoPlaybackRateMouseScroll.value) {
          controlsContainer.addEventListener('wheel', handleControlsContainerWheel)
        }

        if (videoPlaybackRateMouseScroll.value) {
          controlsContainer.addEventListener('click', handleControlsContainerClick, true)
        }
      }

      // title overlay when the video is fullscreened
      // placing this inside the controls container so that we can fade it in and out at the same time as the controls
      const fullscreenTitleOverlay = document.createElement('h1')
      fullscreenTitleOverlay.textContent = props.title
      fullscreenTitleOverlay.className = 'playerFullscreenTitleOverlay'
      fullscreenTitleOverlay.dir = 'auto'
      controlsContainer.appendChild(fullscreenTitleOverlay)

      if (hasLoaded.value && props.chapters.length > 0) {
        createChapterMarkers()
      }

      if (useSponsorBlock.value && sponsorBlockSegments.length > 0) {
        let duration
        if (hasLoaded.value) {
          const seekRange = player.seekRange()

          duration = seekRange.end - seekRange.start
        } else {
          duration = sponsorBlockAverageVideoDuration
        }

        createSponsorBlockMarkers(duration)
      }
    }

    watch(uiConfig, (newValue, oldValue) => {
      if (newValue !== oldValue && ui) {
        configureUI()
      }
    })

    watch(videoVolumeMouseScroll, (newValue, oldValue) => {
      if (newValue !== oldValue && ui) {
        configureUI()
      }
    })

    watch(videoPlaybackRateMouseScroll, (newValue, oldValue) => {
      if (newValue !== oldValue && ui) {
        configureUI()
      }
    })

    watch(videoSkipMouseScroll, (newValue, oldValue) => {
      if (newValue !== oldValue && ui) {
        configureUI()
      }
    })

    watch(() => props.autoplayEnabled, (newValue, oldValue) => {
      if (newValue !== oldValue) {
        events.dispatchEvent(new CustomEvent('setAutoplay', {
          detail: newValue
        }))
      }
    })

    /** @type {ResizeObserver|null} */
    let containerResizeObserver = null

    /** @type {ResizeObserverCallback} */
    function resized(entries) {
      onlyUseOverFlowMenu.value = entries[0].contentBoxSize[0].inlineSize <= USE_OVERFLOW_MENU_WIDTH_THRESHOLD
    }

    // #endregion UI config

    // #region player locales

    // shaka-player ships with some locales prebundled and already loaded
    const loadedLocales = new Set(process.env.SHAKA_LOCALES_PREBUNDLED)

    /**
     * @param {string} locale
     */
    async function setLocale(locale) {
      // For most of FreeTube's locales, there is an equivalent one in shaka-player,
      // however if there isn't one we should fall back to US English.
      // At the time of writing "et", "eu", "gl", "is" don't have any translations
      const shakaLocale = LOCALE_MAPPINGS.get(locale) ?? 'en'

      const localization = ui.getControls().getLocalization()

      const cachedLocales = store.state.player.cachedPlayerLocales

      if (!loadedLocales.has(shakaLocale)) {
        if (!Object.hasOwn(cachedLocales, shakaLocale)) {
          await store.dispatch('cachePlayerLocale', shakaLocale)
        }

        localization.insert(shakaLocale, new Map(Object.entries(cachedLocales[shakaLocale])))

        loadedLocales.add(shakaLocale)
      }

      localization.changeLocale([shakaLocale])

      // Add the keyboard shortcut to the label for the default Shaka controls

      const shakaControlKeysToShortcutLocalizations = new Map()
      Object.entries(shakaControlKeysToShortcuts).forEach(([shakaControlKey, shortcut]) => {
        const originalLocalization = localization.resolve(shakaControlKey)
        if (originalLocalization === '') {
          // e.g., A Shaka localization key in shakaControlKeysToShortcuts has fallen out of date and need to be updated
          console.error('Mising Shaka localization key "%s"', shakaControlKey)
          return
        }

        const localizationWithShortcut = addKeyboardShortcutToActionTitle(
          originalLocalization,
          shortcut
        )

        shakaControlKeysToShortcutLocalizations.set(shakaControlKey, localizationWithShortcut)
      })

      localization.insert(shakaLocale, shakaControlKeysToShortcutLocalizations)

      events.dispatchEvent(new CustomEvent('localeChanged'))
    }

    watch(locale, setLocale)

    // #endregion player locales

    // #region power save blocker

    function startPowerSaveBlocker() {
      if (process.env.IS_ELECTRON) {
        window.ftElectron.startPowerSaveBlocker()
      }
    }

    function stopPowerSaveBlocker() {
      if (process.env.IS_ELECTRON) {
        window.ftElectron.stopPowerSaveBlocker()
      }
    }

    // #endregion power save blocker

    // #region video event handlers

    function handlePlay() {
      startPowerSaveBlocker()

      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
      }
    }

    function handlePause() {
      stopPowerSaveBlocker()

      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused'
      }
    }

    function handleEnded() {
      stopPowerSaveBlocker()

      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none'
      }

      emit('ended')
    }

    function handleCanPlay() {
      // PiP can only be activated once the video's readState and video track are populated
      if (startInPip && props.format !== 'audio' && ui.getControls().isPiPAllowed() && process.env.IS_ELECTRON) {
        startInPip = false
        window.ftElectron.requestPiP()
      }
    }

    // #region volume

    /** @type {AudioGainStage|null} */
    let gainStage = null

    /**
     * The volume the user asked for, as a fraction, before this video's loudness
     * correction is applied to it. May exceed 1, unlike the video element's own volume.
     */
    let baseVolume = 1

    /**
     * Splits the user's volume preference into the part the video element can
     * express and the gain factor for the rest, as the element refuses anything
     * above 1. The two always multiply back to the preference.
     * @param {number} volume
     */
    function storeBaseVolume(volume) {
      baseVolume = volume

      sessionStorage.setItem('volume', Math.min(volume, 1).toString())
      sessionStorage.setItem('gain', Math.max(volume, 1).toString())
    }

    function restoreBaseVolume() {
      const volume = sessionStorage.getItem('volume')
      const gain = sessionStorage.getItem('gain')

      if (volume !== null) {
        baseVolume = parseFloat(volume) * (gain === null ? 1 : parseFloat(gain))
      }
    }

    /** @type {VolumeState} */
    const volumeState = {
      get maxPercent() {
        return maxVolume.value
      },
      get basePercent() {
        return baseVolume * 100
      },
      get normalizationGain() {
        return normalizationGain.value
      },
      get gain() {
        return gainStage?.gain ?? 1
      },
      setBasePercent: (percent) => {
        storeBaseVolume(percent / 100)
      },
      setGain: (gain) => {
        gainStage?.setGain(gain)
      }
    }

    // Both the ceiling and the correction can change while a video is playing
    watch([maxVolume, normalizationGain], () => {
      events.dispatchEvent(new CustomEvent('volumeSettingsChanged'))
    })

    function updateVolume() {
      const video_ = video.value

      // What the user hears: the element's own volume, times whatever the gain
      // stage adds on top of it
      const effectiveVolume = video_.volume * volumeState.gain

      // The volume preference itself is stored by the volume bar as the user
      // changes it, rather than being read back from the element here, because
      // what the element ends up playing at has this video's loudness correction
      // and the volume ceiling folded into it.

      // https://docs.videojs.com/html5#volume
      if (sessionStorage.getItem('muted') === 'false' && video_.volume === 0) {
        // If video is muted by dragging volume slider, it doesn't change 'muted' in sessionStorage to true
        // hence compare it with 'false' and set volume to defaultVolume.
        storeBaseVolume(parseFloat(sessionStorage.getItem('defaultVolume')))
        sessionStorage.setItem('muted', 'true')
      } else {
        // If volume isn't muted by dragging the slider, muted and volume values are carried over to next video.
        sessionStorage.setItem('muted', String(video_.muted))
      }

      if (showStats.value) {
        stats.volume = (effectiveVolume * 100).toFixed(1)
      }
    }

    // #endregion volume

    function handleTimeupdate() {
      if (video.value) {
        const currentTime = video.value.currentTime

        emit('timeupdate', currentTime)

        if (showStats.value && hasLoaded.value) {
          updateStats()
        }

        if (useSponsorBlock.value && sponsorBlockSegments.length > 0 && canSeek()) {
          skipSponsorBlockSegments(currentTime)
        }
      }
    }

    const videoElementWidth = ref(0)
    const videoElementHeight = ref(0)

    /** @type {ResizeObserver} */
    const videoResizeObserver = new ResizeObserver(() => {
      if (video.value) {
        const devicePixelRatio = window.devicePixelRatio > 1 ? window.devicePixelRatio : 1
        const video_ = video.value

        videoElementWidth.value = video_.clientWidth * devicePixelRatio
        videoElementHeight.value = video_.clientHeight * devicePixelRatio
      }
    })

    /** @type {PictureInPictureWindow | null} */
    let pipWindow = null
    const pipWindowWidth = ref(null)
    const pipWindowHeight = ref(null)

    /**
     * @param {PictureInPictureEvent} event
     */
    function handleEnterPictureInPicture(event) {
      pipWindow = event.pictureInPictureWindow
      handlePictureInPictureResize()
      pipWindow.addEventListener('resize', handlePictureInPictureResize)
    }

    function handleLeavePictureInPicture() {
      pipWindow.removeEventListener('resize', handlePictureInPictureResize)

      pipWindow = null
      pipWindowWidth.value = null
      pipWindowHeight.value = null
    }

    function handlePictureInPictureResize() {
      const devicePixelRatio = window.devicePixelRatio > 1 ? window.devicePixelRatio : 1

      pipWindowWidth.value = pipWindow.width * devicePixelRatio
      pipWindowHeight.value = pipWindow.height * devicePixelRatio
    }

    const playerWidth = computed(() => Math.round(pipWindowWidth.value ?? videoElementWidth.value))
    const playerHeight = computed(() => Math.round(pipWindowHeight.value ?? videoElementHeight.value))

    // #endregion video event handlers

    // #region SABR

    /** @type {shaka.extern.Manifest | undefined} */
    let sabrManifest

    /**
     * The watch view's regulator, borrowed for as long as this player lives.
     * It owns the `sabr://` scheme slot and every recovery decision, and it
     * outlives us on purpose: reloading this player is one of the remedies it
     * chooses, so its budgets cannot be ours to keep.
     * @type {import('../../helpers/player/SabrRegulator').SabrRegulator | undefined}
     */
    const sabrRegulator = props.sabrRegulator

    /** @type {import('../../helpers/player/SabrSchemePlugin').SabrSession | undefined} */
    let sabrStream
    /** @type {AbortController | undefined} */
    let sabrAbortController

    /**
     * True from the first credential refresh until the video plays again or
     * the ladder gives up. Asked of the regulator as well as subscribed to,
     * because this player may have been built in the middle of an episode
     * that began before it existed.
     */
    const isRecoveringFromWall = ref(false)

    /** True while the session is being rebuilt, when there is no media at all */
    const isRebuildingSabrSession = ref(false)

    if (process.env.SUPPORTS_LOCAL_API && sabrRegulator) {
      sabrRegulator.attach({
        getPlayer: () => player,
        getManifest: () => sabrManifest,
        playerWidth,
        playerHeight,
        onRecoveryStarted: () => { isRecoveringFromWall.value = true },
        onRecoveryEnded: () => { isRecoveringFromWall.value = false },
      })

      // An episode can have begun before this player existed, since reloading
      // the player is one of the remedies
      isRecoveringFromWall.value = sabrRegulator.isRecovering()
    }

    /**
     * Starts a SABR session and wires up what it reports. Called again from
     * `hardReloadSabrSession`, which rebuilds the session from scratch, so
     * nothing here may assume it only ever runs once.
     * @param {import('../../views/Watch/Watch').SabrData} sabrData
     */
    function initSabrScheme(sabrData) {
      sabrStream = sabrRegulator.startSession(sabrData)
      sabrAbortController = new AbortController()

      // Since there can be 2 requests at the same time (video + audio), we debounce the listener to only show the message once
      sabrStream.onBackoffRequested(debounce(({ backoffMs }) => {
        // Every fresh session opens with a routine backoff, so during recovery
        // this fires over and over to count down something the viewer can do
        // nothing about, next to a message that actually explains the wait
        if (isRecoveringFromWall.value) { return }

        showToast(
          ({ remainingMs }) => {
            // `+value` converts string back to float
            return t('Video.Watch.Remaining SABR backoff time: {remindingTimeSeconds}s', { remindingTimeSeconds: +(remainingMs / 1000).toFixed(1) })
          },
          // So that we don't see last countdown text like 0/N
          backoffMs,
          null,
          sabrAbortController.signal,
        )
      }, 1000))
      sabrStream.onReloadOnce(({ reason } = {}) => {
        sabrAbortController.abort()
        emit('player-reload-requested', reason)
      })
      sabrStream.onRefreshNeeded(() => {
        refreshSabrCredentials()
      })
      sabrStream.onHardReloadNeededOnce((payload) => {
        hardReloadSabrSession(payload)
      })
    }

    if (process.env.SUPPORTS_LOCAL_API && props.sabrData) {
      initSabrScheme(props.sabrData)
    }

    /** True while a credential refresh is in flight, so a second is not started */
    let sabrRefreshInProgress = false

    /**
     * Fetches fresh SABR credentials from the watch view and swaps them into
     * the running session, so an untrusted PO token can be replaced without
     * tearing down the player. If the refresh cannot complete, the plugin's
     * parked requests fall back to the full player reload by themselves.
     */
    async function refreshSabrCredentials() {
      if (sabrRefreshInProgress || !sabrStream) return
      sabrRefreshInProgress = true

      try {
        const formatIdsBefore = sabrStream.getFormatIds()

        /** @type {{ sabrData: object, formatIds: string[] } | null} */
        const result = await new Promise((resolve) => {
          emit('sabr-refresh-requested', { onResult: resolve })
        })

        if (!result) {
          sabrStream.abandonRefresh(new Error('SABR credential refresh failed'))
          return
        }

        // The buffer is only reusable if the refreshed session still serves
        // every format we hold init data for. An incompatible response
        // abandons the park rather than releasing it: releasing parked
        // requests into a session with different formats would fetch
        // mismatched media into the existing buffer.
        const formatsChanged = formatIdsBefore.some(id => !result.formatIds.includes(id)) ||
          (sabrWallInjectionEnabled && shouldAbandonRefresh())

        if (formatsChanged) {
          sabrStream.abandonRefresh(new Error('SABR formats changed across refresh'))
          return
        }

        sabrStream.refresh(result.sabrData)
      } finally {
        sabrRefreshInProgress = false
      }
    }

    /**
     * Rebuilds the SABR session from scratch, keeping the watch page: fresh
     * credentials, a fresh scheme handler with an empty init data cache, and a
     * fresh media source loaded at the position playback had reached. This is
     * the automatic form of the viewer reopening a walled video, which
     * recovers where swapping credentials underneath the running session does
     * not.
     *
     * Anything that stops it falls back to the full page reload, so behaviour
     * is never worse than before this existed.
     *
     * @param {object} [payload]
     * @param {object} [payload.reloadPlaybackContext] the server's own reload
     * token, when the server is what asked. The fresh player response has to
     * be fetched with it, or YouTube answers with the same finished context.
     */
    async function hardReloadSabrSession({ reloadPlaybackContext } = {}) {
      if (!sabrStream) return

      if (isRebuildingSabrSession.value) {
        // The regulator does not authorise a rebuild while one is unsettled,
        // so reaching here means we and it disagree about what is happening.
        // Saying so and doing nothing is right: it is still waiting on the
        // rebuild we are already running, and reloading the page behind its
        // back is exactly the unauthorised, uncounted remedy this arrangement
        // exists to remove.
        console.error('[SABR recovery] a second session reload was asked for while one was still loading, and was refused')
        return
      }

      isRebuildingSabrSession.value = true

      // The session that asked for this is already finished, so nothing it
      // fails at on the way out is worth reporting as a playback error
      ignoreErrors = true

      try {
        /** @type {{ sabrData: object, formatIds: string[], manifestSrc?: string, manifestMimeType?: string } | null} */
        const result = await new Promise((resolve) => {
          emit('sabr-refresh-requested', { onResult: resolve, reloadPlaybackContext, rebuilding: true })
        })

        if (!result) {
          throw new Error('no fresh credentials')
        }

        // The formats may have changed, and it no longer matters: a rebuild
        // unloads the media source and starts a session with an empty init
        // data cache, so nothing that survives it refers to the old formats.
        // The manifest was the last thing that did, and it is now built from
        // the same player response as the session it describes. Refusing the
        // rebuild over a changed `lastModified` is what used to send a
        // re-encoded video to a page reload.
        if (!result.manifestSrc) {
          throw new Error('no fresh manifest')
        }

        const video_ = video.value
        const playbackPosition = video_.currentTime

        // A video that has never played is not a video the viewer paused: the
        // element's autoplay attribute was still waiting for data when the
        // rebuild took the data away. Restoring "paused" literally is what
        // left a rebuild during the first load showing a play button on a
        // video nobody had touched, where the page reload it replaced would
        // have started playing by itself.
        const neverStarted = video_.played.length === 0
        const shouldResume = !video_.paused || (neverStarted && autoplayVideos.value)

        // Pause for the swap rather than letting the element try to play
        // through it, so the state afterwards is decided rather than raced
        if (!video_.paused) {
          video_.pause()
        }

        const useAutoQuality = player.getConfiguration().abr.enabled
        const activeVariant = player.getVariantTracks().find(track => track.active)

        // Speed is trick play state, which belongs to the load rather than to
        // the player, so it does not survive on its own
        const playbackRate = player.getPlaybackRate()

        const activeCaptionIndex = player.getTextTracks().findIndex(caption => caption.active)
        restoreCaptionIndex = activeCaptionIndex >= 0 ? activeCaptionIndex : null

        // Unload before replacing the session: it cancels the requests still
        // in flight, so the plugin's parked ones bow out as cancelled instead
        // of reading the teardown as a failed refresh and asking for a page
        // reload on top of this one
        try {
          await player.unload()
        } catch { }

        sabrAbortController.abort()
        // Finishes the old session and starts the new one in one step, without
        // the scheme slot ever being vacant
        initSabrScheme(result.sabrData)

        ignoreErrors = false

        player.configure(getPlayerConfig(props.format, useAutoQuality))
        configureStreamingTimeout()

        await player.load(result.manifestSrc, playbackPosition, result.manifestMimeType)

        restoreTrackSelection(useAutoQuality, activeVariant)

        if (playbackRate !== defaultPlaybackRate.value) {
          player.trickPlay(playbackRate, false)
        }

        if (shouldResume) {
          // Reloading a media element does not resume it, and a viewer who was
          // watching did not ask to be stopped. A refused resume leaves them
          // with a loaded video and a play button, which is not worth throwing
          // the page away over.
          try {
            await video_.play()
          } catch (error) {
            console.warn(`[SABR recovery] session rebuilt but playback did not resume (${error?.message ?? error})`)
          }
        } else {
          video_.pause()
        }

        console.warn(`[SABR recovery] session rebuilt, resuming at ${playbackPosition.toFixed(1)}s`)
      } catch (error) {
        // The regulator may have moved past this rebuild while it was running:
        // ordered a page reload, or ended the ladder. Either kills the load we
        // are waiting on, and reading that as our own failure is how a verdict
        // became a page reload nobody counted, with the error screen it wanted
        // never reaching the viewer. Hand the error on instead and let it be
        // what it is: an abort is nothing to report, and a give-up is the view's.
        if (sabrRegulator.rebuildWasSuperseded()) {
          console.warn(`[SABR recovery] session reload abandoned (${error?.message ?? error}), the regulator has already decided what happens next`)

          ignoreErrors = false
          handleError(error, 'sabr session reload')
          return
        }

        console.error(`[SABR recovery] session reload failed (${error?.message ?? error}), falling back to a page reload`)

        sabrAbortController?.abort()
        emit('player-reload-requested', `the session reload failed: ${error?.message ?? error}`)
      } finally {
        isRebuildingSabrSession.value = false

        // However it went, the regulator may authorise another one. It
        // deliberately does not hear this when the load never resolves, which
        // is the case that used to produce two page reloads from two owners.
        sabrRegulator.noteRebuildSettled()
      }
    }

    /**
     * Puts the viewer back on the track they were watching after a reload that
     * did not change format. Only meaningful when they picked a quality
     * themselves; automatic quality finds its own way back.
     * @param {boolean} useAutoQuality
     * @param {shaka.extern.Track | undefined} previousVariant
     */
    function restoreTrackSelection(useAutoQuality, previousVariant) {
      if (!previousVariant) return

      if (useAutoQuality) {
        if (!previousVariant.label) return

        for (const track of deduplicateAudioTracks(player.getAudioTracks()).values()) {
          if (track.label === previousVariant.label) {
            player.selectAudioTrack(track)
            break
          }
        }

        return
      }

      if (props.format === 'dash') {
        const dimension = previousVariant.height > previousVariant.width ? previousVariant.width : previousVariant.height

        setDashQuality(dimension, previousVariant.audioBandwidth, previousVariant.label)
        return
      }

      let variants = player.getVariantTracks()

      if (previousVariant.label) {
        variants = variants.filter(variant => variant.label === previousVariant.label)
      }

      const chosenVariant = typeof previousVariant.audioBandwidth === 'number'
        ? findMostSimilarAudioBandwidth(variants, previousVariant.audioBandwidth)
        : variants.reduce((previous, current) => {
            return previous === null || current.bandwidth > previous.bandwidth ? current : previous
          }, null)

      if (chosenVariant) {
        player.selectVariantTrack(chosenVariant)
      }
    }

    /**
     * Hands the regulator back: it gives up the `sabr://` scheme slot and
     * finishes the session behind it, while keeping the recovery budgets,
     * which belong to the video rather than to this player.
     *
     * Called from both teardown paths, and safe to call twice: the watch view
     * hides the player on an error, which unmounts us without going through
     * `destroyPlayer`.
     */
    function releaseSabrRegulator() {
      if (!process.env.SUPPORTS_LOCAL_API || !sabrRegulator) { return }

      sabrRegulator.detach()
      sabrAbortController?.abort()

      sabrStream = undefined
    }

    // #endregion SABR

    // #region request/response filters

    /** @type {shaka.extern.RequestFilter} */
    function requestFilter(type, request, _context) {
      if (type === RequestType.SEGMENT) {
        const url = new URL(request.uris[0])

        // only when we aren't proxying through Invidious,
        // it doesn't like the range param and makes get requests to youtube anyway
        if (url.protocol !== 'sabr:' && url.hostname.endsWith('.googlevideo.com') && url.pathname === '/videoplayback') {
          request.method = 'POST'
          request.body = new Uint8Array([0x78, 0]) // protobuf: { 15: 0 } (no idea what it means but this is what YouTube uses)

          if (request.headers.Range) {
            request.uris[0] += `&range=${request.headers.Range.split('=')[1]}`
            delete request.headers.Range
          }

          request.uris[0] += '&alr=yes'
        }
      }
    }

    /** @type {shaka.extern.ResponseFilter} */
    async function responseFilter(type, response, context) {
      if (type === RequestType.SEGMENT) {
        const url = new URL(response.uri)

        if (url.protocol === 'sabr:') {
          return
        }

        if (response.data && response.data.byteLength > 4 &&
          new DataView(response.data).getUint32(0) === HTTP_IN_HEX) {
          // Interpret the response data as a URL string.
          const responseAsString = shaka.util.StringUtils.fromUTF8(response.data)

          const retryParameters = player.getConfiguration().streaming.retryParameters

          // Make another request for the redirect URL.
          const uris = [responseAsString]
          const redirectRequest = shaka.net.NetworkingEngine.makeRequest(uris, retryParameters)
          const requestOperation = player.getNetworkingEngine().request(type, redirectRequest, context)
          const redirectResponse = await requestOperation.promise

          // Modify the original response to contain the results of the redirect
          // response.
          response.data = redirectResponse.data
          response.headers = redirectResponse.headers
          response.uri = redirectResponse.uri
        } else {
          // Fix positioning for auto-generated subtitles
          if (url.hostname.endsWith('.youtube.com') && url.pathname === '/api/timedtext' &&
            url.searchParams.get('caps') === 'asr' && url.searchParams.get('kind') === 'asr' && url.searchParams.get('fmt') === 'vtt') {
            const stringBody = new TextDecoder().decode(response.data)
            // position:0% for LTR text and position:100% for RTL text
            const cleaned = stringBody.replaceAll(/ align:start position:(?:10)?0%$/gm, '')

            response.data = new TextEncoder().encode(cleaned).buffer
          }
        }
      } else if (type === RequestType.MANIFEST && context.type === AdvancedRequestType.MEDIA_PLAYLIST) {
        const url = new URL(response.uri)

        let modifiedText

        // Fixes proxied HLS manifests, as Invidious replaces the path parameters with query parameters,
        // so shaka-player isn't able to infer the mime type from the `/file/seg.ts` part like it does for non-proxied HLS manifests.
        // Shaka-player does attempt to detect it with HEAD request but the `Content-Type` header is `application/octet-stream`,
        // which still doesn't tell shaka-player how to handle the stream because that's the equivalent of saying "binary data".
        if (url.searchParams.has('local')) {
          const stringBody = new TextDecoder().decode(response.data)

          modifiedText = stringBody.replaceAll(/https?:\/\/.+$/gm, hlsProxiedUrlReplacer)
        }

        // The audio-only streams are actually raw AAC, so correct the file extension from `.ts` to `.aac`
        if (/\/itag\/23[34]\//.test(url.pathname) || url.searchParams.get('itag') === '233' || url.searchParams.get('itag') === '234') {
          if (!modifiedText) {
            modifiedText = new TextDecoder().decode(response.data)
          }

          modifiedText = modifiedText.replaceAll('/file/seg.ts', '/file/seg.aac')
        }

        if (modifiedText) {
          response.data = new TextEncoder().encode(modifiedText).buffer
        }
      }
    }

    /**
     * @param {string} match
     */
    function hlsProxiedUrlReplacer(match) {
      const url = new URL(match)

      let fileValue
      for (const [key, value] of url.searchParams) {
        if (key === 'file') {
          fileValue = value
          continue
        } else if (key === 'hls_chunk_host') {
          // Add the host parameter so some Invidious instances stop complaining about the missing host parameter
          // Replace .c.youtube.com with .googlevideo.com as the built-in Invidious video proxy only accepts host parameters with googlevideo.com
          url.pathname += `/host/${encodeURIComponent(value.replace('.c.youtube.com', '.googlevideo.com'))}`
        }

        url.pathname += `/${key}/${encodeURIComponent(value)}`
      }

      // This has to be right at the end so that shaka-player can read the file extension
      url.pathname += `/file/${encodeURIComponent(fileValue)}`

      url.search = ''
      return url.toString()
    }

    // #endregion request/response filters

    // #region set quality

    /**
     * @param {number} quality
     * @param {number | undefined} audioBandwidth
     * @param {string | undefined} label
     */
    function setDashQuality(quality, audioBandwidth, label) {
      let variants = player.getVariantTracks()

      if (label) {
        variants = variants.filter(variant => variant.label === label)
      } else if (hasMultipleAudioTracks.value) {
        // default audio track
        const filteredVariants = variants.filter(variant => variant.audioRoles.includes('main'))
        // Sometimes there is nothing marked as main, don't filter in this case
        if (filteredVariants.length > 0) {
          variants = filteredVariants
        }
      }

      const isPortrait = variants[0].height > variants[0].width

      let matches = variants.filter(variant => {
        const { width, height } = variant
        const [primary, secondary] = isPortrait ? [width, height] : [height, width]
        const aspectRatio = secondary / primary
        const resolution = aspectRatio > 16 / 9 ? Math.round(secondary * 9 / 16) : primary
        return quality === resolution
      })

      if (matches.length === 0) {
        matches = variants.filter(variant => {
          return quality > (isPortrait ? variant.width : variant.height)
        })
      }

      // Nothing at or below the preferred quality, which a PeerTube live
      // without transcoding does with its one variant: take the lowest there is
      // rather than selecting nothing, which throws
      if (matches.length === 0) {
        matches = [...variants].sort((a, b) => isPortrait ? a.width - b.width : a.height - b.height).slice(0, 1)
      }

      matches.sort((a, b) => isPortrait ? b.width - a.width : b.height - a.height)

      let chosenVariant

      if (typeof audioBandwidth === 'number') {
        const width = matches[0].width
        const height = matches[0].height

        matches = matches.filter(variant => variant.width === width && variant.height === height)

        chosenVariant = findMostSimilarAudioBandwidth(matches, audioBandwidth)
      } else {
        chosenVariant = matches[0]
      }

      player.selectVariantTrack(chosenVariant)
    }

    /**
     * @param {number|null} playbackPosition
     * @param {number|undefined} previousQuality
     */
    async function setLegacyQuality(playbackPosition = null, previousQuality = undefined) {
      if (typeof previousQuality === 'undefined') {
        if (defaultQuality.value === 'auto') {
          previousQuality = Infinity
        } else {
          previousQuality = defaultQuality.value
        }
      }

      /** @type {object[]} */
      const legacyFormats = props.legacyFormats
      if (legacyFormats.length === 0) { return }

      const isPortrait = legacyFormats[0].height > legacyFormats[0].width

      let matches = legacyFormats.filter(variant => {
        return previousQuality === isPortrait ? variant.width : variant.height
      })

      if (matches.length === 0) {
        matches = legacyFormats.filter(variant => {
          return previousQuality > isPortrait ? variant.width : variant.height
        })

        if (matches.length > 0) {
          matches.sort((a, b) => b.bitrate - a.bitrate)
        } else {
          matches = legacyFormats.sort((a, b) => a.bitrate - b.bitrate)
        }
      }

      hasMultipleAudioTracks.value = false

      events.dispatchEvent(new CustomEvent('setLegacyFormat', {
        detail: {
          format: matches[0],
          playbackPosition
        }
      }))
    }

    // #endregion set quality

    // #region stats

    function gatherInitialStatsValues() {
      /** @type {HTMLVideoElement} */
      const video_ = video.value

      stats.volume = (video_.volume * volumeState.gain * 100).toFixed(1)

      if (props.format === 'legacy') {
        updateLegacyQualityStats(activeLegacyFormat.value)
      }

      if (!hasLoaded.value) {
        player.addEventListener('loaded', () => {
          if (showStats.value) {
            if (props.format !== 'legacy') {
              updateQualityStats({
                newTrack: player.getVariantTracks().find(track => track.active)
              })
            }

            updateStats()
          }
        }, {
          once: true
        })

        return
      }

      if (props.format !== 'legacy') {
        updateQualityStats({
          newTrack: player.getVariantTracks().find(track => track.active)
        })
      }

      updateStats()
    }

    /**
     * @param {{
     *   type: ('adaptation'|'variantchanged'),
     *   newTrack: shaka.extern.Track,
     *   oldTrack: shaka.extern.Track
     * }} track
     */
    function updateQualityStats({ newTrack }) {
      if (!showStats.value || props.format === 'legacy') {
        return
      }

      stats.bitrate = (newTrack.bandwidth / 1000).toFixed(2)

      // Combined audio and video HLS streams
      if (newTrack.videoCodec?.includes(',')) {
        stats.codecs.audioItag = ''
        stats.codecs.videoItag = ''

        const [audioCodec, videoCodec] = newTrack.videoCodec.split(',')

        stats.codecs.audioCodec = audioCodec
        stats.codecs.videoCodec = videoCodec

        stats.resolution.frameRate = newTrack.frameRate
        stats.resolution.width = newTrack.width
        stats.resolution.height = newTrack.height
      } else {
        stats.codecs.audioItag = newTrack.originalAudioId.split('-', 1)[0]
        stats.codecs.audioCodec = newTrack.audioCodec

        if (props.format === 'dash') {
          stats.resolution.frameRate = newTrack.frameRate

          stats.codecs.videoItag = newTrack.originalVideoId.split('-', 1)[0]
          stats.codecs.videoCodec = newTrack.videoCodec

          stats.resolution.width = newTrack.width
          stats.resolution.height = newTrack.height
        }
      }
    }

    function updateLegacyQualityStats(newFormat) {
      if (!showStats.value || props.format !== 'legacy') {
        return
      }

      const { fps, bitrate, mimeType, itag, width, height } = newFormat

      const codecsMatch = mimeType.match(/codecs="(?<videoCodec>.+), ?(?<audioCodec>.+)"/)

      stats.codecs.audioItag = itag
      stats.codecs.audioCodec = codecsMatch.groups.audioCodec

      stats.codecs.videoItag = itag
      stats.codecs.videoCodec = codecsMatch.groups.videoCodec

      stats.resolution.frameRate = fps

      stats.bitrate = (bitrate / 1000).toFixed(2)

      stats.resolution.width = width
      stats.resolution.height = height
    }

    function updateStats() {
      const playerStats = player.getStats()

      if (props.format !== 'audio') {
        stats.frames = {
          droppedFrames: playerStats.droppedFrames,
          totalFrames: playerStats.decodedFrames
        }
      }

      if (props.format !== 'legacy') {
        // estimated bandwidth is NaN for legacy, as none of the requests go through shaka,
        // so it has no way to estimate the bandwidth
        stats.bandwidth = (playerStats.estimatedBandwidth / 1000).toFixed(2)
      }

      let bufferedSeconds = 0

      const buffered = player.getBufferedInfo().total

      for (const { start, end } of buffered) {
        bufferedSeconds += end - start
      }

      const seekRange = player.seekRange()
      const duration = seekRange.end - seekRange.start

      stats.buffered = ((bufferedSeconds / duration) * 100).toFixed(2)
    }

    watch(showStats, (newValue) => {
      if (newValue) {
        // for abr changes/auto quality
        player.addEventListener('adaptation', updateQualityStats)

        // for manual changes e.g. in quality selector
        player.addEventListener('variantchanged', updateQualityStats)
      } else {
        // for abr changes/auto quality
        player.removeEventListener('adaptation', updateQualityStats)

        // for manual changes e.g. in quality selector
        player.removeEventListener('variantchanged', updateQualityStats)
      }
    })

    watch(activeLegacyFormat, updateLegacyQualityStats)

    // #endregion stats

    // #region screenshots

    async function takeScreenshot() {
      const video_ = video.value

      const width = video_.videoWidth
      const height = video_.videoHeight

      if (width <= 0) {
        return
      }

      // Need to set crossorigin="anonymous" for LegacyFormat on Invidious
      // https://developer.mozilla.org/en-US/docs/Web/HTML/CORS_enabled_image
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(video_, 0, 0)

      // Navigator Clipboard API only supports PNG
      const format = screenshotMode.value === 'clipboard' ? 'png' : screenshotFormat.value
      const mimeType = `image/${format === 'jpg' ? 'jpeg' : format}`
      // imageQuality is ignored for pngs, so it is still okay to pass the quality value
      const imageQuality = screenshotQuality.value / 100

      const wasPlaying = !video_.paused
      if ((!process.env.IS_ELECTRON || screenshotMode.value === 'prompt_folder') && wasPlaying) {
        video_.pause()
      }

      try {
        /** @type {Blob} */
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, imageQuality))

        if (screenshotMode.value === 'clipboard') {
          await copyToClipboard(blob, { messageOnSuccess: t('Screenshot Clipboard Success'), messageOnError: t('Screenshot Clipboard Error') })
        } else if (screenshotMode.value === 'prompt_folder' || screenshotMode.value === 'default_folder') {
          let filename
          try {
            filename = await store.dispatch('parseScreenshotCustomFileName', {
              date: new Date(),
              playerTime: video_.currentTime,
              videoId: props.videoId
            })
          } catch (err) {
            console.error(`Parse failed: ${err.message}`)
            showToast(t('Screenshot Error', { error: err.message }))
            canvas.remove()
            return
          }

          const filenameWithExtension = `${filename}.${format}`

          if (!process.env.IS_ELECTRON || screenshotMode.value === 'prompt_folder') {
            const saved = await writeFileWithPicker(
              filenameWithExtension,
              blob,
              format.toUpperCase(),
              mimeType,
              `.${format}`,
              'player-screenshots',
              'pictures'
            )

            if (saved) {
              showToast(t('Screenshot Success'))
            }
          } else {
            const arrayBuffer = await blob.arrayBuffer()

            if (await window.ftElectron.writeToDefaultFolder(filenameWithExtension, arrayBuffer)) {
              showToast(t('Screenshot Success'))
            }
          }
        }
      } catch (error) {
        console.error(error)
        showToast(t('Screenshot Error', { error }))
      } finally {
        canvas.remove()

        if ((!process.env.IS_ELECTRON || screenshotMode.value === 'prompt_folder') && wasPlaying) {
          video_.play()
        }
      }
    }

    // #endregion screenshots

    // #region custom player controls

    const { ContextMenu: shakaContextMenu, Controls: shakaControls, OverflowMenu: shakaOverflowMenu } = shaka.ui

    function registerAudioTrackSelection() {
      /** @implements {shaka.extern.IUIElement.Factory} */
      class AudioTrackSelectionFactory {
        create(rootElement, controls) {
          return new AudioTrackSelection(events, rootElement, controls)
        }
      }

      shakaControls.registerElement('ft_audio_tracks', new AudioTrackSelectionFactory())
      shakaOverflowMenu.registerElement('ft_audio_tracks', new AudioTrackSelectionFactory())
    }

    function registerAutoplayToggle() {
      events.addEventListener('toggleAutoplay', () => {
        emit('toggle-autoplay')
      })

      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class AutoplayToggleFactory {
        create(rootElement, controls) {
          return new AutoplayToggle(props.autoplayEnabled, events, rootElement, controls)
        }
      }

      shakaControls.registerElement('ft_autoplay_toggle', new AutoplayToggleFactory())
      shakaOverflowMenu.registerElement('ft_autoplay_toggle', new AutoplayToggleFactory())
    }

    function registerTheatreModeButton() {
      events.addEventListener('toggleTheatreMode', () => {
        emit('toggle-theatre-mode')
      })

      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class TheatreModeButtonFactory {
        create(rootElement, controls) {
          return new TheatreModeButton(props.useTheatreMode, events, rootElement, controls)
        }
      }

      shakaControls.registerElement('ft_theatre_mode', new TheatreModeButtonFactory())
      shakaOverflowMenu.registerElement('ft_theatre_mode', new TheatreModeButtonFactory())
    }

    function registerPinControlsButton() {
      events.addEventListener('setPinControls', (/** @type {CustomEvent} */ event) => {
        store.dispatch('updatePinPlayerControls', event.detail)
      })

      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class PinControlsButtonFactory {
        create(rootElement, controls) {
          return new PinControlsButton(pinPlayerControls.value, events, rootElement, controls)
        }
      }

      shakaControls.registerElement('ft_pin_controls', new PinControlsButtonFactory())
      shakaOverflowMenu.registerElement('ft_pin_controls', new PinControlsButtonFactory())
    }

    function registerFullWindowButton() {
      events.addEventListener('setFullWindow', (/** @type {CustomEvent} */ event) => {
        if (event.detail) {
          window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
        }

        fullWindowEnabled.value = event.detail

        if (fullWindowEnabled.value) {
          document.body.classList.add('playerFullWindow')
        } else {
          document.body.classList.remove('playerFullWindow')
        }
      })

      if (startInFullwindow) {
        events.dispatchEvent(new CustomEvent('setFullWindow', {
          detail: true
        }))
      }

      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class FullWindowButtonFactory {
        create(rootElement, controls) {
          return new FullWindowButton(fullWindowEnabled.value, events, rootElement, controls)
        }
      }

      shakaControls.registerElement('ft_full_window', new FullWindowButtonFactory())
      shakaOverflowMenu.registerElement('ft_full_window', new FullWindowButtonFactory())
    }

    function registerLegacyQualitySelection() {
      events.addEventListener('setLegacyFormat', async (/** @type {CustomEvent} */ event) => {
        const { format, playbackPosition, restoreCaptionIndex: restoreCaptionIndex_ = null } = event.detail

        if (restoreCaptionIndex_ !== null) {
          restoreCaptionIndex = restoreCaptionIndex_
        }

        activeLegacyFormat.value = event.detail.format
        try {
          await player.load(format.url, playbackPosition, format.mimeType)
        } catch (error) {
          handleError(error, 'setLegacyFormat', event.detail)
        }
      })

      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class LegacyQualitySelectionFactory {
        create(rootElement, controls) {
          return new LegacyQualitySelection(
            activeLegacyFormat.value,
            props.legacyFormats,
            events,
            rootElement,
            controls
          )
        }
      }

      shakaControls.registerElement('ft_legacy_quality', new LegacyQualitySelectionFactory())
      shakaOverflowMenu.registerElement('ft_legacy_quality', new LegacyQualitySelectionFactory())
    }

    function registerStatsButton() {
      events.addEventListener('setStatsVisibility', (/** @type {CustomEvent} */ event) => {
        showStats.value = event.detail

        if (showStats.value) {
          gatherInitialStatsValues()
        }
      })

      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class StatsButtonFactory {
        create(rootElement, controls) {
          return new StatsButton(showStats.value, events, rootElement, controls)
        }
      }

      shakaContextMenu.registerElement('ft_stats', new StatsButtonFactory())
    }

    function registerScreenshotButton() {
      events.addEventListener('takeScreenshot', () => {
        takeScreenshot()
      })

      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class ScreenshotButtonFactory {
        create(rootElement, controls) {
          return new ScreenshotButton(events, rootElement, controls)
        }
      }

      shakaControls.registerElement('ft_screenshot', new ScreenshotButtonFactory())
      shakaOverflowMenu.registerElement('ft_screenshot', new ScreenshotButtonFactory())
    }

    function registerSkipButtons() {
      // skip to next video button
      events.addEventListener('nextVideo', () => {
        emit('skip-to-next')
      })

      class SkipNextButtonFactory {
        create(rootElement, controls) {
          return new SkipButton(events, rootElement, controls, 'next')
        }
      }

      shakaControls.registerElement('ft_skip_next', new SkipNextButtonFactory())
      shakaOverflowMenu.registerElement('ft_skip_next', new SkipNextButtonFactory())

      // skip to previous video button
      events.addEventListener('previousVideo', () => {
        emit('skip-to-prev')
      })

      class SkipPreviousButtonFactory {
        create(rootElement, controls) {
          return new SkipButton(events, rootElement, controls, 'previous')
        }
      }

      shakaControls.registerElement('ft_skip_previous', new SkipPreviousButtonFactory())
      shakaOverflowMenu.registerElement('ft_skip_previous', new SkipPreviousButtonFactory())
    }

    function registerVolumeBar() {
      /**
       * @implements {shaka.extern.IUIElement.Factory}
       */
      class VolumeBarFactory {
        create(rootElement, controls) {
          return new VolumeBar(volumeState, events, rootElement, controls)
        }
      }

      shakaControls.registerElement('ft_volume', new VolumeBarFactory())
    }

    /**
     * As shaka-player doesn't let you unregister custom control factories,
     * overwrite them with `null` instead so the referenced objects
     * (e.g. {@linkcode events}, {@linkcode fullWindowEnabled}) can get garbage collected
     */
    function cleanUpCustomPlayerControls() {
      shakaControls.registerElement('ft_audio_tracks', null)
      shakaOverflowMenu.registerElement('ft_audio_tracks', null)

      shakaControls.registerElement('ft_autoplay_toggle', null)
      shakaOverflowMenu.registerElement('ft_autoplay_toggle', null)

      shakaControls.registerElement('ft_theatre_mode', null)
      shakaOverflowMenu.registerElement('ft_theatre_mode', null)

      shakaControls.registerElement('ft_full_window', null)
      shakaOverflowMenu.registerElement('ft_full_window', null)

      shakaControls.registerElement('ft_pin_controls', null)
      shakaOverflowMenu.registerElement('ft_pin_controls', null)

      shakaControls.registerElement('ft_legacy_quality', null)
      shakaOverflowMenu.registerElement('ft_legacy_quality', null)

      shakaContextMenu.registerElement('ft_stats', null)

      shakaControls.registerElement('ft_screenshot', null)
      shakaOverflowMenu.registerElement('ft_screenshot', null)

      shakaControls.registerElement('ft_next_previous', null)
      shakaOverflowMenu.registerElement('ft_next_previous', null)

      shakaControls.registerElement('ft_skip_previous', null)
      shakaOverflowMenu.registerElement('ft_skip_previous', null)

      shakaControls.registerElement('ft_volume', null)
    }

    // #endregion custom player controls

    // #region mouse and keyboard helpers

    /**
     * @param {number} stepDb how much to change the volume by, in dB. The volume
     * bar's travel is logarithmic, and its bounds are its own, as it knows both
     * the ceiling and whether boosting past 100% is possible for this video.
     */
    function changeVolume(stepDb) {
      const volumeBar = container.value.querySelector('.shaka-volume-bar')

      const minValue = parseFloat(volumeBar.min)
      const maxValue = parseFloat(volumeBar.max)

      const oldValue = parseFloat(volumeBar.value)
      const newValue = Math.min(Math.max(oldValue + stepDb, minValue), maxValue)

      volumeBar.value = newValue

      volumeBar.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))

      let messageIcon
      if (newValue <= minValue) {
        messageIcon = 'volume-mute'
      } else if (newValue < oldValue) {
        messageIcon = 'volume-low'
      } else if (newValue > oldValue) {
        messageIcon = 'volume-high'
      }

      // Reported as a percentage, which is what the rest of the player speaks in,
      // and read back from the element so that a refused boost isn't claimed
      showValueChange(
        `${Math.round(video.value.volume * volumeState.gain * 100)}%`,
        messageIcon
      )
    }

    /**
     * @param {number} step
     */
    function changePlayBackRate(step) {
      const newPlaybackRateString = (player.getPlaybackRate() + step).toFixed(2)
      const newPlaybackRate = parseFloat(newPlaybackRateString)

      // The following error is thrown if you go below 0.07:
      // The provided playback rate (0.05) is not in the supported playback range.
      if (newPlaybackRate > 0.07 && newPlaybackRate <= maxVideoPlaybackRate.value) {
        if (newPlaybackRate === defaultPlaybackRate.value) {
          player.cancelTrickPlay()
        } else {
          player.trickPlay(newPlaybackRate, false)
        }

        showValueChange(`${newPlaybackRateString}x`)
      }
    }

    function canSeek() {
      if (!player || !hasLoaded.value) {
        return false
      }

      const seekRange = player.seekRange()

      // Seeking not possible e.g. with HLS
      if (seekRange.start === seekRange.end || !seekingIsPossible.value) {
        return false
      }

      return true
    }

    /**
     * @param {number} seconds The number of seconds to seek by, positive values seek forwards, negative ones seek backwards
     * @param {boolean} canSeekResult Allow functions that have already checked whether seeking is possible, to skip the extra check (e.g. frameByFrame)
     * @param {boolean} showPopUp Whether to show a pop-up with the seconds seeked
     */
    function seekBySeconds(seconds, canSeekResult = false, showPopUp = false) {
      if (!(canSeekResult || canSeek())) {
        return
      }

      const seekRange = player.seekRange()

      const video_ = video.value

      const currentTime = video_.currentTime
      const newTime = currentTime + seconds

      if (newTime < seekRange.start) {
        video_.currentTime = seekRange.start
      } else if (newTime > seekRange.end) {
        if (isLive.value) {
          player.goToLive()
        } else {
          video_.currentTime = seekRange.end
        }
      } else {
        video_.currentTime = newTime
      }
      if (showPopUp) {
        const popUpLayout = seconds > 0
          ? { icon: 'arrow-right', invertContentOrder: true }
          : { icon: 'arrow-left', invertContentOrder: false }
        // `+value` converts string back to float
        const formattedSeconds = +Math.abs(seconds).toFixed(2)
        showValueChange(`${formattedSeconds}s`, popUpLayout.icon, popUpLayout.invertContentOrder)
      }

      showOverlayControls()
    }

    // #endregion mouse and keyboard helpers

    // #region mouse scroll handlers

    const mouseScrollThrottleWaitMs = 200

    /**
     * @param {WheelEvent} event
     */
    function mouseScrollPlaybackRate(event) {
      if ((event.deltaY < 0 || event.deltaX > 0)) {
        changePlayBackRate(0.05)
      } else if ((event.deltaY > 0 || event.deltaX < 0)) {
        changePlayBackRate(-0.05)
      }
    }
    const mouseScrollPlaybackRateThrottle = throttle(mouseScrollPlaybackRate, mouseScrollThrottleWaitMs)
    /**
     * @param {WheelEvent} event
     */
    function mouseScrollPlaybackRateHandler(event) {
      event.preventDefault()

      // Touchpad scroll = small deltaX/deltaY
      if (Math.abs(event.deltaX) <= 5 && Math.abs(event.deltaY) <= 5) {
        mouseScrollPlaybackRateThrottle(event)
      } else {
        mouseScrollPlaybackRate(event)
      }
    }

    /**
     * @param {WheelEvent} event
     */
    function mouseScrollSkip(event) {
      if ((event.deltaY < 0 || event.deltaX > 0)) {
        seekBySeconds(defaultSkipInterval.value * player.getPlaybackRate(), true)
      } else if ((event.deltaY > 0 || event.deltaX < 0)) {
        seekBySeconds(-defaultSkipInterval.value * player.getPlaybackRate(), true)
      }
    }
    const mouseScrollSkipThrottle = throttle(mouseScrollSkip, mouseScrollThrottleWaitMs)
    /**
     * @param {WheelEvent} event
     */
    function mouseScrollSkipHandler(event) {
      if (canSeek()) {
        event.preventDefault()

        // Touchpad scroll = small deltaX/deltaY
        if (Math.abs(event.deltaX) <= 5 && Math.abs(event.deltaY) <= 5) {
          mouseScrollSkipThrottle(event)
        } else {
          mouseScrollSkip(event)
        }
      }
    }

    /**
     * @param {WheelEvent} event
     */
    function mouseScrollVolume(event) {
      const video_ = video.value

      if (video_.muted && (event.deltaY < 0 || event.deltaX > 0)) {
        video_.muted = false
        video_.volume = 0
      }

      if (!video_.muted) {
        if ((event.deltaY < 0 || event.deltaX > 0)) {
          changeVolume(VOLUME_STEP_DB)
        } else if ((event.deltaY > 0 || event.deltaX < 0)) {
          changeVolume(-VOLUME_STEP_DB)
        }
      }
    }
    const mouseScrollVolumeThrottle = throttle(mouseScrollVolume, mouseScrollThrottleWaitMs)
    /**
     * @param {WheelEvent} event
     */
    function mouseScrollVolumeHandler(event) {
      if (!event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        event.stopPropagation()

        // Touchpad scroll = small deltaX/deltaY
        if (Math.abs(event.deltaX) <= 5 && Math.abs(event.deltaY) <= 5) {
          mouseScrollVolumeThrottle(event)
        } else {
          mouseScrollVolume(event)
        }
      }
    }

    // #endregion mouse scroll handlers

    // #region keyboard shortcuts

    /**
     * determines whether the jump to the previous or next chapter
     * with the the keyboard shortcuts, should be done
     * first it checks whether there are any chapters (the array is also empty if chapters are hidden)
     * it also checks that the approprate combination was used ALT/OPTION on macOS and CTRL everywhere else
     * @param {KeyboardEvent} event the keyboard event
     * @param {string} direction the direction of the jump either previous or next
     */
    function canChapterJump(event, direction) {
      const currentChapter = props.currentChapterIndex
      return props.chapters.length > 0 &&
        (direction === 'previous' ? currentChapter > 0 : props.chapters.length - 1 !== currentChapter) &&
        ((process.platform !== 'darwin' && event.ctrlKey) ||
          (process.platform === 'darwin' && event.metaKey))
    }

    /**
     * @param {number} step
     */
    function frameByFrame(step) {
      if (props.format === 'audio' || !canSeek()) {
        return
      }

      video.value.pause()

      /** @type {number} */
      let fps
      if (props.format === 'legacy') {
        fps = activeLegacyFormat.value.fps
      } else {
        fps = player.getVariantTracks().find(track => track.active).frameRate
      }

      const frameTime = 1 / fps
      const dist = frameTime * step
      seekBySeconds(dist, true)
    }

    // Blur player buttons to remove :focus-visible state, preventing tooltips from staying visible
    const buttonWithTooltipClasses = [
      'shaka-play-button',
      'shaka-fullscreen-button',
      'shaka-mute-button',
      'shaka-pip-button',
      'full-window-button',
      'theatre-button',
      'screenshot-button',
    ]
    function blurTooltipButtons() {
      const element = document.activeElement
      if (buttonWithTooltipClasses.some(className => element.classList.contains(className))) {
        element.blur()
      }
    }

    /**
     * @param {KeyboardEvent} event
     */
    function keyboardShortcutHandler(event) {
      if (!player) {
        return
      }

      if (document.activeElement.classList.contains('ft-input') || event.altKey) {
        return
      }

      // exit fullscreen and/or fullwindow if keyboard shortcut modal is opened
      if (event.shiftKey && event.key === '?') {
        event.preventDefault()

        if (ui.getControls().isFullScreenEnabled()) {
          ui.getControls().toggleFullScreen()
        }

        if (fullWindowEnabled.value) {
          events.dispatchEvent(new CustomEvent('setFullWindow', {
            detail: !fullWindowEnabled.value
          }))
        }

        return
      }

      // allow chapter jump keyboard shortcuts
      if (event.ctrlKey && (process.platform === 'darwin' || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'))) {
        return
      }

      // allow copying text
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        return
      }

      // allow focusing on search bar without affecting the playback
      if ((process.platform === 'darwin' && event.metaKey) && event.key.toLowerCase() === 'l') {
        return
      }

      const video_ = video.value

      // Skip to next video in playlist or recommended
      if (event.shiftKey && event.key.toLowerCase() === 'n') {
        emit('skip-to-next')
        return
      }

      // Skip to previous video in playlist
      if (event.shiftKey && event.key.toLowerCase() === 'p') {
        emit('skip-to-prev')
        return
      }

      switch (event.key.toLowerCase()) {
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.FULLSCREEN:
          // Toggle full screen
          event.preventDefault()
          ui.getControls().toggleFullScreen()
          blurTooltipButtons()
          break
        case 'escape':
          // Exit full window
          if (fullWindowEnabled.value) {
            event.preventDefault()

            events.dispatchEvent(new CustomEvent('setFullWindow', {
              detail: false
            }))
          }
          break
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.FULLWINDOW:
          // Toggle full window mode
          event.preventDefault()
          events.dispatchEvent(new CustomEvent('setFullWindow', {
            detail: !fullWindowEnabled.value
          }))
          blurTooltipButtons()
          break
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.THEATRE_MODE:
          // Toggle theatre mode
          if (props.theatrePossible) {
            event.preventDefault()

            events.dispatchEvent(new CustomEvent('toggleTheatreMode', {
              detail: !props.useTheatreMode
            }))
          }
          blurTooltipButtons()
          break
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.MUTE:
          // Toggle mute only if metakey is not pressed
          if (!event.metaKey) {
            event.preventDefault()
            const isMuted = !video_.muted
            video_.muted = isMuted

            const messageIcon = isMuted ? 'volume-mute' : 'volume-high'
            const message = isMuted ? '0%' : `${Math.round(video_.volume * 100)}%`
            showValueChange(message, messageIcon)
          }
          blurTooltipButtons()
          break
      }

      if (!hasLoaded.value) {
        return
      }

      switch (event.key.toLowerCase()) {
        case ' ':
        case 'spacebar': // older browsers might return spacebar instead of a space character
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.PLAY:
          // Toggle Play/Pause
          event.preventDefault()
          video_.paused ? video_.play() : video_.pause()
          blurTooltipButtons()
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.LARGE_REWIND:
          // Rewind by 2x the time-skip interval (in seconds)
          event.preventDefault()
          seekBySeconds(-defaultSkipInterval.value * player.getPlaybackRate() * 2, false, true)
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.LARGE_FAST_FORWARD:
          // Fast-Forward by 2x the time-skip interval (in seconds)
          event.preventDefault()
          seekBySeconds(defaultSkipInterval.value * player.getPlaybackRate() * 2, false, true)
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.DECREASE_VIDEO_SPEED:
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.DECREASE_VIDEO_SPEED_ALT:
          // Decrease playback rate by user configured interval
          event.preventDefault()
          changePlayBackRate(-videoPlaybackRateInterval.value)
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.INCREASE_VIDEO_SPEED:
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.INCREASE_VIDEO_SPEED_ALT:
          // Increase playback rate by user configured interval
          event.preventDefault()
          changePlayBackRate(videoPlaybackRateInterval.value)
          break
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.CAPTIONS: {
          // Toggle caption/subtitles

          const textTracks = player.getTextTracks()
          if (textTracks.length > 0) {
            event.preventDefault()

            if (textTracks.some(track => track.active)) {
              player.selectTextTrack(null)
            } else {
              player.selectTextTrack(textTracks[0])
            }

            showOverlayControls()
          }
          break
        }
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.VOLUME_UP:
          // Increase volume
          event.preventDefault()
          changeVolume(VOLUME_STEP_DB)
          break
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.VOLUME_DOWN:
          // Decrease Volume
          event.preventDefault()
          changeVolume(-VOLUME_STEP_DB)
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.SMALL_REWIND:
          if (event.shiftKey) {
            break
          }
          event.preventDefault()
          if (canChapterJump(event, 'previous')) {
            // Jump to the previous chapter
            video_.currentTime = props.chapters[props.currentChapterIndex - 1].startSeconds
            showOverlayControls()
          } else {
            // Rewind by the time-skip interval (in seconds)
            seekBySeconds(-defaultSkipInterval.value * player.getPlaybackRate(), false, true)
          }
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.SMALL_FAST_FORWARD:
          if (event.shiftKey) {
            break
          }
          event.preventDefault()
          if (canChapterJump(event, 'next')) {
            // Jump to the next chapter
            video_.currentTime = (props.chapters[props.currentChapterIndex + 1].startSeconds)
            showOverlayControls()
          } else {
            // Fast-Forward by the time-skip interval (in seconds)
            seekBySeconds(defaultSkipInterval.value * player.getPlaybackRate(), false, true)
          }
          break
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.PICTURE_IN_PICTURE:
          // Toggle picture in picture
          if (props.format !== 'audio') {
            const controls = ui.getControls()
            if (controls.isPiPAllowed()) {
              controls.togglePiP()
            }
          }
          blurTooltipButtons()
          break
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9': {
          // Jump to percentage in the video
          if (canSeek()) {
            event.preventDefault()

            // use seek range instead of duration so that it works for live streams too
            const seekRange = player.seekRange()

            const length = seekRange.end - seekRange.start
            const percentage = parseInt(event.key) / 10

            video_.currentTime = seekRange.start + (length * percentage)
            showOverlayControls()
          }
          break
        }
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.LAST_FRAME:
          // `⌘+,` is for settings in MacOS
          if (!event.metaKey && video_.paused) {
            event.preventDefault()
            // Return to previous frame
            frameByFrame(-1)
          }
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.NEXT_FRAME:
          if (video_.paused) {
            event.preventDefault()
            // Advance to next frame
            frameByFrame(1)
          }
          break
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.STATS:
          // Toggle stats display
          event.preventDefault()

          events.dispatchEvent(new CustomEvent('setStatsVisibility', {
            detail: !showStats.value
          }))
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.HOME:
          // Jump to beginning of video
          if (canSeek()) {
            event.preventDefault()
            // use seek range instead of duration so that it works for live streams too
            const seekRange = player.seekRange()
            video_.currentTime = seekRange.start
            showOverlayControls()
          }
          break
        case KeyboardShortcuts.VIDEO_PLAYER.PLAYBACK.END:
          // Jump to end of video
          if (canSeek()) {
            event.preventDefault()
            // use seek range instead of duration so that it works for live streams too
            const seekRange = player.seekRange()
            video_.currentTime = seekRange.end
            showOverlayControls()
          }
          break
        case KeyboardShortcuts.VIDEO_PLAYER.GENERAL.TAKE_SCREENSHOT:
          if (enableScreenshot.value && props.format !== 'audio') {
            event.preventDefault()
            // Take screenshot
            takeScreenshot()
          }
          blurTooltipButtons()
          break
      }
    }

    // #endregion keyboard shortcuts

    let ignoreErrors = false

    /** Consecutive errors shaka-player said it had already dealt with */
    let shakaHandledErrors = 0

    /** When the last of those arrived, to tell a loop from separate incidents */
    let lastShakaHandledErrorAt = 0

    /**
     * @param {shaka.util.Error} error
     * @param {string} context
     * @param {object?} details
     */
    function handleError(error, context, details) {
      // These two errors are just wrappers around another error, so use the original error instead
      // As they can be nested (e.g. multiple googlevideo redirects because the Invidious server was far away from the user) we should pick the inner most one
      while (error.code === ErrorCode.REQUEST_FILTER_ERROR || error.code === ErrorCode.RESPONSE_FILTER_ERROR) {
        error = error.data[0]
      }

      // Allow shaka-player to retry on potentially recoverable network errors
      if (error.severity === ErrorSeverity.RECOVERABLE && error.category === ErrorCategory.NETWORK) {
        /** @type {keyof ErrorCategory} */
        const categoryText = Object.keys(ErrorCategory).find((/** @type {keyof ErrorCategory} */ key) => ErrorCategory[key] === error.category)

        /** @type {keyof ErrorCode} */
        const codeText = Object.keys(ErrorCode).find((/** @type {keyof ErrorCode} */ key) => ErrorCode[key] === error.code)

        console.warn(
          'Recoverable network error retrying...\n' +
          `Category: ${categoryText} (${error.category})\n` +
          `Code: ${codeText} (${error.code})\n` +
          'Data', error.data
        )
        return
      }

      logShakaError(error, context, props.videoId, details)

      // shaka-player sets `handled` when it has already taken its own remedy
      // for this error: for a failed SourceBuffer append that means it reset
      // the media source and is carrying on from the same position, and for a
      // network failure that it dropped the offending stream for a sibling.
      // It fires the error event either way, so acting on one of these used to
      // undo a recovery that was already under way. What the viewer saw was a
      // video replaced by audio at the start over a single rejected segment,
      // which YouTube may well have served badly only once.
      //
      // Standing aside has to happen before `ignoreErrors` latches below,
      // because that latch is only ever released by a format switch or a
      // session reload. Setting it here without changing format would mean
      // every later error in the video went unanswered.
      if (error.handled === true) {
        const now = Date.now()

        if (now - lastShakaHandledErrorAt > SHAKA_HANDLED_ERROR_WINDOW_MS) {
          shakaHandledErrors = 0
        }

        shakaHandledErrors += 1
        lastShakaHandledErrorAt = now

        if (shakaHandledErrors <= SHAKA_HANDLED_ERROR_LIMIT) {
          console.warn(
            `shaka-player reports it has already handled this error, leaving it to recover (${shakaHandledErrors}/${SHAKA_HANDLED_ERROR_LIMIT})`
          )
          return
        }

        // Out of patience: its recovery is not converging, so fall through and
        // let the format fallback have its turn after all.
        console.error(
          `shaka-player has handled ${shakaHandledErrors} errors in a row without recovering, so treating this one as fatal`
        )
      }

      // text related errors aren't serious (captions and seek bar thumbnails), so we should just log them
      // TODO: consider only emitting when the severity is crititcal?
      if (
        !ignoreErrors &&
        error.category !== shaka.util.Error.Category.TEXT &&
        !(error.code === shaka.util.Error.Code.BAD_HTTP_STATUS && error.data[0].startsWith('https://www.youtube.com/api/timedtext'))
      ) {
        // don't react to multiple consecutive errors, otherwise we don't give the format fallback from the previous error a chance to work
        ignoreErrors = true

        emit('error', error)

        stopPowerSaveBlocker()

        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'none'
        }
      }
    }

    // #region seek bar markers

    /**
     * @param {number} duration As the sponsorblock segments can sometimes load before the video does, we need to pass in the duration here
     */
    function createSponsorBlockMarkers(duration) {
      addMarkers(
        sponsorBlockSegments.map(segment => {
          const markerDiv = document.createElement('div')

          markerDiv.title = translateSponsorBlockCategory(segment.category)
          markerDiv.className = `sponsorBlockMarker main${sponsorSkips.value.categoryData[segment.category].color}`
          markerDiv.style.width = `${((segment.endTime - segment.startTime) / duration) * 100}%`
          markerDiv.style.left = `${(segment.startTime / duration) * 100}%`

          return markerDiv
        })
      )
    }

    function createChapterMarkers() {
      const { start, end } = player.seekRange()
      const duration = end - start

      /**
       * @type {{
       *   title: string,
       *   timestamp: string,
       *   startSeconds: number,
       *   endSeconds: number,
       *   thumbnail?: string
       * }[]}
       */
      const chapters = props.chapters

      addMarkers(
        chapters.map(chapter => {
          const markerDiv = document.createElement('div')

          markerDiv.title = chapter.title
          markerDiv.className = 'chapterMarker'
          markerDiv.style.left = `calc(${(chapter.startSeconds / duration) * 100}% - 1px)`

          return markerDiv
        })
      )
    }

    /**
     * @param {HTMLDivElement[]} markers
     */
    function addMarkers(markers) {
      const seekBarContainer = container.value.querySelector('.shaka-seek-bar-container')

      if (seekBarContainer.firstElementChild?.classList.contains('markerContainer')) {
        /** @type {HTMLDivElement} */
        const markerBar = seekBarContainer.firstElementChild

        markers.forEach(marker => markerBar.appendChild(marker))
      } else {
        const markerBar = document.createElement('div')
        markerBar.className = 'markerContainer'

        markers.forEach(marker => markerBar.appendChild(marker))

        seekBarContainer.insertBefore(markerBar, seekBarContainer.firstElementChild)
      }
    }

    // #endregion seek bar markers

    // #region offline message

    const isOffline = ref(!navigator.onLine)
    const isBuffering = ref(false)

    function onlineHandler() {
      isOffline.value = false
    }

    function offlineHandler() {
      isOffline.value = true
    }

    function fullscreenChangeHandler() {
      nextTick(showOverlayControls)
    }

    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)

    // Only display the offline message while buffering/the loading symbol is visible.
    // If we briefly lose the connection but it comes back before the buffer is empty,
    // the user won't notice anything so we don't need to display the message.
    const showOfflineMessage = computed(() => {
      return isOffline.value && isBuffering.value
    })

    // Same rule as the offline message, for the same reason: recovery from a
    // refused session is usually over before the buffer runs out, and saying
    // so while the viewer is still watching happily would be crying wolf. Once
    // there is nothing left to play they can see something is wrong, and an
    // ordinary buffering spinner promises a moment when this can take a minute
    // and can end in an error. Being offline is the more actionable of the
    // two, so it wins if somehow both are true.
    const showRecoveryMessage = computed(() => {
      return isRecoveringFromWall.value &&
        (isBuffering.value || isRebuildingSabrSession.value) &&
        !showOfflineMessage.value
    })

    // #endregion offline message

    // #region setup
    const initLoadWaitTimeToastAC = new AbortController()

    onMounted(async () => {
      const videoElement = video.value

      restoreBaseVolume()
      gainStage = new AudioGainStage(videoElement)

      // Only the part of the volume the element can express itself. Anything past
      // that needs the gain stage, which the volume bar engages once it knows
      // whether this video's audio can go through it at all.
      videoElement.volume = Math.min(baseVolume, 1)

      const muted = sessionStorage.getItem('muted')
      if (muted !== null) {
        // as sessionStorage stores string values which are truthy by default so we must check with 'true'
        // otherwise 'false' will be returned as true as well
        videoElement.muted = (muted === 'true')
      }

      const localPlayer = new shaka.Player()

      ui = new shaka.ui.Overlay(
        localPlayer,
        container.value,
        videoElement,
        vrCanvas.value
      )

      // This has to be called after creating the UI, so that the player uses the UI's UITextDisplayer
      // otherwise it uses the browsers native captions which get displayed underneath the UI controls
      await localPlayer.attach(videoElement)

      videoElement.playbackRate = props.currentPlaybackRate
      videoElement.defaultPlaybackRate = defaultPlaybackRate.value

      // check if the component is already getting destroyed
      // which is possible because this function runs asynchronously
      if (!ui) {
        return
      }

      const controls = ui.getControls()
      player = controls.getPlayer()

      player.addEventListener('buffering', event => {
        isBuffering.value = event.buffering
      })

      player.addEventListener('error', event => handleError(event.detail, 'shaka error handler'))

      player.configure(getPlayerConfig(props.format, defaultQuality.value === 'auto'))

      if (process.env.SUPPORTS_LOCAL_API) {
        player.getNetworkingEngine().registerRequestFilter(requestFilter)
        player.getNetworkingEngine().registerResponseFilter(responseFilter)
      }

      await setLocale(locale.value)

      // check if the component is already getting destroyed
      // which is possible because this function runs asynchronously
      if (!ui || !player) {
        return
      }

      videoResizeObserver.observe(videoElement)

      registerScreenshotButton()
      registerAudioTrackSelection()
      registerAutoplayToggle()

      registerTheatreModeButton()
      registerFullWindowButton()
      registerPinControlsButton()
      registerLegacyQualitySelection()
      registerStatsButton()
      registerSkipButtons()
      registerVolumeBar()

      if (ui.isMobile()) {
        onlyUseOverFlowMenu.value = true
      } else {
        onlyUseOverFlowMenu.value = container.value.getBoundingClientRect().width <= USE_OVERFLOW_MENU_WIDTH_THRESHOLD

        containerResizeObserver = new ResizeObserver(resized)
        containerResizeObserver.observe(container.value)
      }

      controls.addEventListener('uiupdated', addUICustomizations)
      configureUI(true)

      if (pinPlayerControls.value) {
        // shaka's `showUIAlways` only keeps shown controls from hiding, so
        // bring them up once for pinning to hold on to
        showOverlayControls()
      }

      document.removeEventListener('keydown', keyboardShortcutHandler)
      document.addEventListener('keydown', keyboardShortcutHandler)
      document.addEventListener('fullscreenchange', fullscreenChangeHandler)

      player.addEventListener('loading', () => {
        hasLoaded.value = false
      })

      player.addEventListener('loaded', handleLoaded)

      if (props.format !== 'legacy') {
        player.addEventListener('streaming', () => {
          if (props.format === 'dash') {
            const firstVariant = player.getVariantTracks()[0]

            // force the player aspect ratio to 16:9 to avoid overflowing the layout
            forceAspectRatio.value = firstVariant.width / firstVariant.height < 1.5
          }
        })
      } else if (props.legacyFormats.length > 0) {
        // force the player aspect ratio to 16:9 to avoid overflowing the layout, when the video is too tall

        const firstFormat = props.legacyFormats[0]
        forceAspectRatio.value = firstFormat.width / firstFormat.height < 1.5
      }

      if (useSponsorBlock.value && sponsorSkips.value.seekBar.length > 0) {
        setupSponsorBlock()
      }

      window.addEventListener('beforeunload', stopPowerSaveBlocker)

      // shaka-player doesn't start with the cursor hidden, so hide it here for instances in which the
      // cursor is in the video player area when the video first loads
      container.value.classList.add('no-cursor')
      container.value.addEventListener('mousemove', hideCursorWhenStillWhilePinned)

      await performFirstLoad()
      // Whatever runs after `performFirstLoad` might be after switching to another page due to SABR backoff

      player?.addEventListener('ratechange', () => {
        emit('playback-rate-updated', player.getPlaybackRate())
      })
    })
    onUnmounted(() => {
      initLoadWaitTimeToastAC.abort()
    })

    /**
     * SABR answers a single request with a whole stream of parts, so it needs
     * longer than a plain segment fetch. Reapplied on every load, since a
     * session reload builds its configuration afresh.
     */
    function configureStreamingTimeout() {
      player.configure({
        streaming: {
          retryParameters: {
            timeout: process.env.SUPPORTS_LOCAL_API && sabrStream ? 30 * 1000 * 2 : 30 * 1000,
          }
        }
      })
    }

    async function performFirstLoad() {
      configureStreamingTimeout()

      const initialLoadDelayMs = props.delayLoadUntilUnix - Date.now()
      if (initialLoadDelayMs > 0 && (props.format === 'legacy' || props.manifestMimeType !== MANIFEST_TYPE_SABR)) {
        showToast(
          ({ remainingMs }) => {
            // `+value` converts string back to float
            return t('Video.Watch.Remaining preroll-ad time: {remindingTimeSeconds}s', { remindingTimeSeconds: +(remainingMs / 1000).toFixed(1) })
          },
          // So that we don't see last countdown text like 0/N
          initialLoadDelayMs,
          null,
          initLoadWaitTimeToastAC.signal,
        )
        await new Promise((resolve) => setTimeout(resolve, initialLoadDelayMs))
      }

      if (props.format === 'dash' || props.format === 'audio') {
        try {
          await player.load(props.manifestSrc, props.startTime, props.manifestMimeType)

          if (defaultQuality.value !== 'auto') {
            if (props.format === 'dash') {
              setDashQuality(defaultQuality.value)
            } else {
              let variants = player.getVariantTracks()

              if (hasMultipleAudioTracks.value) {
                // default audio track
                variants = variants.filter(variant => variant.audioRoles.includes('main'))
              }

              const highestBandwidth = Math.max(...variants.map(variant => variant.audioBandwidth))
              variants = variants.filter(variant => variant.audioBandwidth === highestBandwidth)

              // None in src= mode, as a PeerTube progressive audio file plays
              if (variants.length > 0 || player.getLoadMode() !== shaka.Player.LoadMode.SRC_EQUALS) {
                player.selectVariantTrack(variants[0])
              }
            }
          }
        } catch (error) {
          handleError(error, 'loading dash/audio manifest and setting default quality in mounted')
        }
      } else {
        await setLegacyQuality(props.startTime)
      }
    }

    /**
     * Adds the captions and thumbnail tracks, also restores the previously selected captions track,
     * if this was triggered by a format change and the user had the captions enabled.
     */
    async function handleLoaded() {
      hasLoaded.value = true
      emit('loaded')

      // ideally we would set this in the `streaming` event handler, but for HLS this is only set to true after the loaded event fires.
      isLive.value = player.isLive()
      // getAudioTracks() returns an empty array when no variant is active, so we can't do this in the `streaming` event
      hasMultipleAudioTracks.value = deduplicateAudioTracks(player.getAudioTracks()).size > 1

      if (process.env.SUPPORTS_LOCAL_API && props.format !== 'legacy' && props.manifestMimeType === MANIFEST_TYPE_SABR) {
        sabrManifest = player.getManifest()
      }

      // For SABR we include the thumbnails, chapters and subtitles in the manifest
      if (!process.env.SUPPORTS_LOCAL_API || props.format === 'legacy' || props.manifestMimeType !== MANIFEST_TYPE_SABR) {
        const promises = []

        for (const caption of props.captions) {
          if (props.format === 'legacy') {
            const url = new URL(caption.url)

            if (url.hostname.endsWith('.youtube.com') && url.pathname === '/api/timedtext' &&
              url.searchParams.get('caps') === 'asr' && url.searchParams.get('kind') === 'asr' && url.searchParams.get('fmt') === 'vtt') {
              promises.push((async () => {
                try {
                  const response = await fetch(caption.url)
                  let text = await response.text()

                  // position:0% for LTR text and position:100% for RTL text
                  text = text.replaceAll(/ align:start position:(?:10)?0%$/gm, '')

                  const url = `data:${caption.mimeType};charset=utf-8,${encodeURIComponent(text)}`

                  await player.addTextTrackAsync(
                    url,
                    caption.language,
                    'captions',
                    caption.mimeType,
                    undefined, // codec, only needed if the captions are inside a container (e.g. mp4)
                    caption.label
                  )
                } catch (error) {
                  if (error instanceof shaka.util.Error) {
                    handleError(error, 'addTextTrackAsync', caption)
                  } else {
                    console.error(error)
                  }
                }
              })())
            } else {
              promises.push(
                player.addTextTrackAsync(
                  caption.url,
                  caption.language,
                  'captions',
                  caption.mimeType,
                  undefined, // codec, only needed if the captions are inside a container (e.g. mp4)
                  caption.label
                )
                  .catch(error => handleError(error, 'addTextTrackAsync', caption))
              )
            }
          } else {
            promises.push(
              player.addTextTrackAsync(
                caption.url,
                caption.language,
                'captions',
                caption.mimeType,
                undefined, // codec, only needed if the captions are inside a container (e.g. mp4)
                caption.label
              )
                .catch(error => handleError(error, 'addTextTrackAsync', caption))
            )
          }
        }

        if (!isLive.value && props.storyboardSrc) {
          promises.push(
            // Only log the error, as the thumbnails are a nice to have
            // If an error occurs with them, it's not critical
            player.addThumbnailsTrack(props.storyboardSrc, 'text/vtt')
              .catch(error => logShakaError(error, 'addThumbnailsTrack', props.videoId, props.storyboardSrc))
          )
        }

        if (!isLive.value && props.chaptersSrc.length > 0) {
          promises.push(
            // Only log the error, as the chapters are a nice to have (we have our own UI outside of the player too)
            // If an error occurs with them, it is not critical
            player.addChaptersTrack(props.chaptersSrc, 'und', 'text/vtt')
              .catch(error => logShakaError(error, 'addChaptersTrack', props.videoId, props.chaptersSrc))
          )
        }

        await Promise.all(promises)
      }

      if (restoreCaptionIndex !== null) {
        const index = restoreCaptionIndex
        restoreCaptionIndex = null

        const textTrack = player.getTextTracks()[index]

        if (textTrack) {
          player.selectTextTrack(textTrack)
        }
      }

      if (props.chapters.length > 0) {
        createChapterMarkers()
      }

      if (startInFullscreen && process.env.IS_ELECTRON) {
        startInFullscreen = false
        window.ftElectron.requestFullscreen()
      }
    }

    watch(
      () => props.format,
      /**
       * Handles changing between formats. It tries its best to backup and restore the settings:
       * - playback position
       * - paused state
       * - audio track
       * - captions track
       * - video quality
       * @param {'dash'|'audio'|'legacy'} newFormat
       * @param {'dash'|'audio'|'legacy'} oldFormat
       */
      async (newFormat, oldFormat) => {
        ignoreErrors = true

        // format switch happened before the player loaded, probably because of an error
        // as there are no previous player settings to restore, we should treat it like this was the original format
        if (!hasLoaded.value) {
          try {
            await player.unload()
          } catch { }

          ignoreErrors = false

          player.configure(getPlayerConfig(newFormat, defaultQuality.value === 'auto'))

          await performFirstLoad()
          return
        }

        const video_ = video.value

        const wasPaused = video_.paused

        let useAutoQuality = oldFormat === 'legacy' ? defaultQuality.value === 'auto' : player.getConfiguration().abr.enabled

        if (!wasPaused) {
          video_.pause()
        }

        const playbackPosition = video_.currentTime

        const activeCaptionIndex = player.getTextTracks().findIndex(caption => caption.active)

        if (activeCaptionIndex >= 0) {
          restoreCaptionIndex = activeCaptionIndex

          // hide captions before switching as shaka/the browser doesn't clean up the displayed captions
          // when switching away from the legacy formats
          player.selectTextTrack(null)
        } else {
          restoreCaptionIndex = null
        }

        if (newFormat === 'audio' || newFormat === 'dash') {
          let label
          let audioBandwidth
          let dimension

          if (oldFormat === 'legacy' && newFormat === 'dash') {
            const legacyFormat = activeLegacyFormat.value

            if (!useAutoQuality) {
              dimension = legacyFormat.height > legacyFormat.width ? legacyFormat.width : legacyFormat.height
            }
          } else if (oldFormat !== 'legacy') {
            // None active in src= mode, as a PeerTube progressive audio file plays
            const track = player.getVariantTracks().find(track => track.active)

            if (typeof track?.audioBandwidth === 'number') {
              audioBandwidth = track.audioBandwidth
            }

            if (track?.label) {
              label = track.label
            }
          }

          if (oldFormat === 'audio' && newFormat === 'dash' && !useAutoQuality) {
            if (defaultQuality.value !== 'auto') {
              dimension = defaultQuality.value
            } else {
              // Use auto as we don't know what resolution to pick
              useAutoQuality = true
            }
          }

          try {
            await player.unload()
          } catch { }

          ignoreErrors = false

          player.configure(getPlayerConfig(newFormat, useAutoQuality))

          try {
            await player.load(props.manifestSrc, playbackPosition, props.manifestMimeType)

            if (useAutoQuality) {
              if (label) {
                const audioTracks = deduplicateAudioTracks(player.getAudioTracks()).values()

                for (const track of audioTracks) {
                  if (label === track.label) {
                    player.selectAudioTrack(track)
                    break
                  }
                }
              }
            } else {
              if (dimension) {
                setDashQuality(dimension, audioBandwidth, label)
              } else {
                let variants = player.getVariantTracks()

                if (label) {
                  variants = variants.filter(variant => variant.label === label)
                } else if (variants.length > 1) {
                  // default audio track
                  const filteredVariants = variants.filter(variant => variant.audioRoles.includes('main'))
                  // Sometimes there is nothing marked as main, don't filter in this case
                  if (filteredVariants.length > 0) {
                    variants = filteredVariants
                  }
                }

                let chosenVariant

                if (typeof audioBandwidth === 'number') {
                  chosenVariant = findMostSimilarAudioBandwidth(variants, audioBandwidth)
                } else {
                  chosenVariant = variants.reduce((previous, current) => {
                    return previous === null || current.bandwidth > previous.bandwidth ? current : previous
                  }, null)
                }

                // None in src= mode, as a PeerTube progressive audio file plays
                if (chosenVariant || player.getLoadMode() !== shaka.Player.LoadMode.SRC_EQUALS) {
                  player.selectVariantTrack(chosenVariant)
                }
              }
            }
          } catch (error) {
            handleError(error, 'loading dash/audio manifest for format switch', `${oldFormat} -> ${newFormat}`)
          }
          activeLegacyFormat.value = null
        } else {
          let previousQuality

          if (oldFormat === 'dash') {
            const previousTrack = player.getVariantTracks().find(track => track.active)

            previousQuality = previousTrack.height > previousTrack.width ? previousTrack.width : previousTrack.height
          }

          try {
            await player.unload()
          } catch { }

          ignoreErrors = false

          await setLegacyQuality(playbackPosition, previousQuality)
        }

        if (wasPaused) {
          video_.pause()
        }
      }
    )

    // #endregion setup

    // #region tear down

    onBeforeUnmount(() => {
      hasLoaded.value = false
      document.body.classList.remove('playerFullWindow')

      document.removeEventListener('keydown', keyboardShortcutHandler)
      document.removeEventListener('fullscreenchange', fullscreenChangeHandler)

      if (containerResizeObserver) {
        containerResizeObserver.disconnect()
        containerResizeObserver = null
      }

      if (videoResizeObserver) {
        videoResizeObserver.disconnect()
      }

      cleanUpCustomPlayerControls()

      container.value?.removeEventListener('mousemove', hideCursorWhenStillWhilePinned)
      clearPinnedCursorTimeout()

      gainStage?.release()
      gainStage = null

      stopPowerSaveBlocker()
      window.removeEventListener('beforeunload', stopPowerSaveBlocker)

      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none'
      }

      skippedSponsorBlockSegments.value.forEach(segment => clearTimeout(segment.timeoutId))

      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)

      // The watch view hides the player when it shows an error, which unmounts
      // us without going through destroyPlayer. Left alone, the SABR scheme
      // stays registered globally and anything parked on a refresh waits
      // forever, both of which outlive the player that owned them.
      releaseSabrRegulator()
    })

    // #endregion tear down

    // #region functions used by the watch page

    function isPaused() {
      return video.value.paused
    }

    function pause() {
      video.value.pause()
    }

    function getCurrentTime() {
      return video.value.currentTime
    }

    /**
     * @param {number} time
     */
    function setCurrentTime(time) {
      video.value.currentTime = time
    }

    /**
     * Vue's lifecycle hooks are synchonous, so if we destroy the player in {@linkcode onBeforeUnmount},
     * it won't be finished in time, as the player destruction is asynchronous.
     * To workaround that we destroy the player first and wait for it to finish before we unmount this component.
     *
     * @returns {Promise<{ startNextVideoInFullscreen: boolean, startNextVideoInFullwindow: boolean, startNextVideoInPip: boolean }>}
     */
    async function destroyPlayer() {
      ignoreErrors = true

      let uiState = { startNextVideoInFullscreen: false, startNextVideoInFullwindow: false, startNextVideoInPip: false }

      if (ui) {
        if (ui.getControls()) {
          // save the state of player settings to reinitialize them upon next creation
          const controls = ui.getControls()
          uiState = {
            startNextVideoInFullscreen: controls.isFullScreenEnabled(),
            startNextVideoInFullwindow: fullWindowEnabled.value,
            startNextVideoInPip: controls.isPiPEnabled()
          }
        }

        // destroying the ui also destroys the player
        await ui.destroy()
        ui = null
        player = null
      } else if (player) {
        await player.destroy()
        player = null
      }

      releaseSabrRegulator()

      // shaka-player doesn't clear these itself, which prevents shaka.ui.Overlay from being garbage collected
      // Should really be fixed in shaka-player but it's easier just to do it ourselves
      if (container.value) {
        container.value.ui = null
      }

      if (video.value) {
        video.value.ui = null
      }

      return uiState
    }

    expose({
      hasLoaded,

      isPaused,
      pause,
      getCurrentTime,
      setCurrentTime,
      destroyPlayer
    })

    // #endregion functions used by the watch page

    const showValueChangePopup = ref(false)
    const valueChangeMessage = ref('')
    const valueChangeIcon = ref(null)
    const invertValueChangeContentOrder = ref(false)
    let valueChangeTimeout = null

    function showOverlayControls() {
      ui.getControls().showUI()
    }

    /**
     * Shows a popup with a message and an icon on top of the video player.
     * @param {string} message - The message to display.
     * @param {string} icon - The icon to display.
     * @param {boolean} invertContentOrder - Whether to invert the order of the icon and message.
     */
    function showValueChange(message, icon = null, invertContentOrder = false) {
      valueChangeMessage.value = message
      valueChangeIcon.value = icon
      showValueChangePopup.value = true
      invertValueChangeContentOrder.value = invertContentOrder

      if (valueChangeTimeout) {
        clearTimeout(valueChangeTimeout)
      }

      valueChangeTimeout = setTimeout(() => {
        showValueChangePopup.value = false
      }, 2000)

      showOverlayControls()
    }

    return {
      container,
      video,
      vrCanvas,

      fullWindowEnabled,
      forceAspectRatio,

      showStats,
      stats,
      playerDimensions,
      normalizationPercentage,

      autoplayVideos,
      sponsorBlockShowSkippedToast,

      skippedSponsorBlockSegments,

      showOfflineMessage,
      showRecoveryMessage,

      handlePlay,
      handlePause,
      handleCanPlay,
      handleEnded,
      updateVolume,
      handleTimeupdate,
      handleEnterPictureInPicture,
      handleLeavePictureInPicture,

      valueChangeMessage,
      valueChangeIcon,
      showValueChangePopup,
      invertValueChangeContentOrder,
    }
  }
})
