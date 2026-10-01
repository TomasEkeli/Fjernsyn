import store from '../../store/index'

import { getInvidiousChannelVideos, invidiousFetch } from '../api/invidious'
import { getLocalChannelVideos } from '../api/local'
import { parseYouTubeRSSFeed, updateVideoListAfterProcessing } from '../subscriptions'
import { getChannelPlaylistId } from '../utils'
import { probeChannelLiveness } from '../subscriptionChannelLiveness'
import { traceFetchStatus } from '../subscriptionTrace'
import {
  reportFetchError,
  resolveGoneVerdict,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED
} from '../subscriptionFetchStatus'

/**
 * How the videos feed is fetched.
 *
 * This lived in `SubscriptionsVideos.vue` until the refresh became something one
 * manager runs for every feed at once. A refresh has to be able to fetch a feed
 * whose tab is not mounted, so what it needs to do the fetching cannot live in
 * the tab.
 */

const FEED = 'videos'

function backendFallback() {
  return store.getters.getBackendFallback
}

function invidiousInstanceUrl() {
  return store.getters.getCurrentInvidiousInstanceUrl
}

export const videosFeed = {
  feed: FEED,
  cacheGetter: 'getVideoCache',
  updateAction: 'updateSubscriptionVideosCacheByChannel',
  entriesKey: 'videos',
  rssMode: 'setting',
  followsDetailBackfill: true,
  shownGetter: 'getShowSubscriptionsVideos',
  shownAction: 'updateShowSubscriptionsVideos',
  fetchChannel: (channel, { useRss, failedAttempts = 0 }) => {
    if (!process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious') {
      return useRss
        ? getChannelVideosInvidiousRSS(channel, failedAttempts)
        : getChannelVideosInvidiousScraper(channel, failedAttempts)
    }

    return useRss
      ? getChannelVideosLocalRSS(channel, failedAttempts)
      : getChannelVideosLocalScraper(channel, failedAttempts)
  },
  postProcess: updateVideoListAfterProcessing
}

async function getChannelVideosLocalScraper(channel, failedAttempts = 0) {
  try {
    const result = await getLocalChannelVideos(channel.id)

    if (result === null) {
      // ChannelError, so the channel is gone rather than the request having
      // failed. Innertube says so explicitly, which needs no second opinion,
      // but it still passes through the guard: several hundred of these in one
      // refresh would be no more believable than several hundred 404s.
      return await resolveGoneVerdict(FEED, channel, {
        source: 'local-scraper',
        authoritative: true
      })
    }

    // YouTube sent some entries without a title, so the list is short, and
    // the newest upload may be what is missing. RSS lists the newest with
    // their titles, so ask it, unless RSS is how we got here: then the titled
    // entries are the best there is.
    if (result.untitled > 0 && failedAttempts === 0) {
      traceFetchStatus(FEED, channel.id, {
        rung: 'local-scraper',
        status: 200,
        attempt: failedAttempts,
        note: `untitled=${result.untitled} asking RSS`
      })

      return await getChannelVideosLocalRSS(channel, failedAttempts + 1)
    }

    return {
      status: FETCH_OK,
      entries: result.videos,
      name: result.name,
      thumbnailUrl: result.thumbnailUrl
    }
  } catch (err) {
    reportFetchError(FEED, { channel, error: err, api: 'local' })

    switch (failedAttempts) {
      case 0:
        return await getChannelVideosLocalRSS(channel, failedAttempts + 1)
      case 1:
        if (backendFallback()) {
          return await getChannelVideosInvidiousScraper(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelVideosLocalRSS(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelVideosLocalRSS(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'videos', 'newest')
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`

  try {
    const response = await fetch(feedUrl)

    traceFetchStatus(FEED, channel.id, { rung: 'local-rss', status: response.status, attempt: failedAttempts })

    if (response.status === 403 || response.status === 429) {
      return {
        status: FETCH_RATE_LIMITED,
        entries: null
      }
    }

    if (response.status === 404) {
      // playlists don't exist if the channel was terminated but also if it doesn't have the tab,
      // so we need to check the channel feed too before deciding it errored, as that only 404s if the channel was terminated

      const response2 = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`, {
        method: 'HEAD'
      })

      traceFetchStatus(FEED, channel.id, {
        rung: 'local-rss-channel-probe',
        status: response2.status,
        attempt: failedAttempts
      })

      if (response2.status === 404) {
        // Both of those came from the same RSS service, so they are one opinion
        // and not two. Ask something independent before condemning the channel.
        return await resolveGoneVerdict(FEED, channel, {
          source: 'local-rss',
          corroborate: () => probeChannelLiveness(channel)
        })
      }

      // the channel is alive, it just has no videos tab
      return {
        status: FETCH_OK,
        entries: []
      }
    }

    const parsed = await parseYouTubeRSSFeed(await response.text(), channel.id)

    if (parsed.parseFailed) {
      // A 200 carrying something that is not a feed, which is one of the ways
      // YouTube says no. Deliberately not escalating the ladder here: firing
      // more requests at a host that just refused one is the wrong instinct,
      // and the channel stays retryable for later.
      return {
        status: FETCH_FAILED,
        entries: null
      }
    }

    return {
      status: FETCH_OK,
      entries: parsed.videos,
      name: parsed.name
    }
  } catch (error) {
    reportFetchError(FEED, { channel, error, api: 'local' })

    switch (failedAttempts) {
      case 0:
        return await getChannelVideosLocalScraper(channel, failedAttempts + 1)
      case 1:
        if (backendFallback()) {
          return await getChannelVideosInvidiousRSS(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelVideosLocalScraper(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelVideosInvidiousScraper(channel, failedAttempts = 0) {
  try {
    const result = await getInvidiousChannelVideos(channel.id)

    let name

    if (result.videos.length > 0) {
      name = result.videos.find(video => video.type === 'video' && video.author).author
    }

    return {
      status: FETCH_OK,
      entries: result.videos,
      name
    }
  } catch (err) {
    reportFetchError(FEED, { channel, error: err, api: 'invidious' })

    switch (failedAttempts) {
      case 0:
        return await getChannelVideosInvidiousRSS(channel, failedAttempts + 1)
      case 1:
        if (process.env.SUPPORTS_LOCAL_API && backendFallback()) {
          return await getChannelVideosLocalScraper(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelVideosInvidiousRSS(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelVideosInvidiousRSS(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'videos', 'newest')
  const feedUrl = `${invidiousInstanceUrl()}/feed/playlist/${playlistId}`

  try {
    const response = await invidiousFetch(feedUrl)

    traceFetchStatus(FEED, channel.id, { rung: 'invidious-rss', status: response.status, attempt: failedAttempts })

    if (response.status === 403 || response.status === 429) {
      return {
        status: FETCH_RATE_LIMITED,
        entries: null
      }
    }

    if (response.status === 404) {
      // playlists don't exist if the channel was terminated but also if it doesn't have the tab,
      // so we need to check the channel feed too before deciding it errored, as that only 404s if the channel was terminated

      const response2 = await fetch(`${invidiousInstanceUrl()}/feed/channel/${channel.id}`, {
        method: 'GET'
      })

      traceFetchStatus(FEED, channel.id, {
        rung: 'invidious-rss-channel-probe',
        status: response2.status,
        attempt: failedAttempts
      })

      if (response2.status === 404) {
        // Both answers came from the one instance, so they are one opinion. An
        // instance that is broken, blocked or behind should not be able to
        // convince us a channel no longer exists.
        return await resolveGoneVerdict(FEED, channel, {
          source: 'invidious-rss',
          corroborate: () => probeChannelLiveness(channel)
        })
      }

      return {
        status: FETCH_OK,
        entries: []
      }
    }

    const parsed = await parseYouTubeRSSFeed(await response.text(), channel.id)

    if (parsed.parseFailed) {
      return {
        status: FETCH_FAILED,
        entries: null
      }
    }

    return {
      status: FETCH_OK,
      entries: parsed.videos,
      name: parsed.name
    }
  } catch (error) {
    reportFetchError(FEED, { channel, error, api: 'invidious' })

    switch (failedAttempts) {
      case 0:
        return await getChannelVideosInvidiousScraper(channel, failedAttempts + 1)
      case 1:
        if (process.env.SUPPORTS_LOCAL_API && backendFallback()) {
          return await getChannelVideosLocalRSS(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelVideosInvidiousScraper(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}
