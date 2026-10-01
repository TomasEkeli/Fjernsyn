import { describe, expect, it, vi } from 'vitest'
import { Parser, YTNodes } from 'youtubei.js'

import { parseLocalPlaylistVideo, parseLocalPlaylistVideos } from './local'

// Cut down from what YouTube sent for the uploads playlist of
// "Trond Granlund - Topic" (UULFW1rQvQViyJJv_dsq7E4xyQ) on 2026-10-01.

const CHANNEL_ID = 'UCW1rQvQViyJJv_dsq7E4xyQ'

function channelLink(browseId) {
  return {
    innertubeCommand: {
      commandMetadata: {
        webCommandMetadata: {
          url: `/channel/${browseId}`,
          webPageType: 'WEB_PAGE_TYPE_CHANNEL',
          apiUrl: '/youtubei/v1/browse'
        }
      },
      browseEndpoint: { browseId }
    }
  }
}

function lockupViewModel(videoId, lockupMetadataViewModel) {
  return {
    lockupViewModel: {
      contentImage: {
        thumbnailViewModel: {
          image: { sources: [{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 168, height: 94 }] },
          overlays: [{
            thumbnailBottomOverlayViewModel: {
              badges: [{
                thumbnailBadgeViewModel: {
                  text: '3:59',
                  badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT'
                }
              }]
            }
          }]
        }
      },
      metadata: { lockupMetadataViewModel },
      contentId: videoId,
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      rendererContext: {}
    }
  }
}

const titled = lockupViewModel('N-wHLE3HRYQ', {
  title: { content: 'Aleine i skauen' },
  image: {
    decoratedAvatarViewModel: {
      avatar: { avatarViewModel: { image: { sources: [] }, avatarImageSize: 'AVATAR_SIZE_M' } },
      rendererContext: { commandContext: { onTap: channelLink(CHANNEL_ID) } }
    }
  },
  metadata: {
    contentMetadataViewModel: {
      metadataRows: [
        { metadataParts: [{ text: { content: 'Trond Granlund - Topic' } }] },
        { metadataParts: [{ text: { content: '173 views' } }, { text: { content: '7 days ago' } }] }
      ],
      delimiter: ' • '
    }
  }
})

// The same playlist as YouTube sent it now and then: 74 of the 100 entries with
// no title, no avatar and a link to channel "UC", all of them titled again on
// the next request.
const untitled = lockupViewModel('1O5nX9mv3Wk', {
  image: {
    decoratedAvatarViewModel: {
      avatar: { avatarViewModel: { image: {}, avatarImageSize: 'AVATAR_SIZE_M' } },
      rendererContext: { commandContext: { onTap: channelLink('UC') } }
    }
  },
  metadata: {
    contentMetadataViewModel: {
      metadataRows: [{ metadataParts: [{ text: { content: 'No views' } }] }],
      delimiter: ' • '
    }
  }
})

/**
 * youtubei.js reports a node it cannot parse and carries on without it, which
 * is the case under test, so keep its report out of the test output.
 */
function parseQuietly(raw) {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    return Parser.parseItem(raw, YTNodes.LockupView)
  } finally {
    error.mockRestore()
  }
}

describe('parseLocalPlaylistVideo', () => {
  it('reads a video lockup', () => {
    const video = parseLocalPlaylistVideo(parseQuietly(titled))

    expect(video).toMatchObject({
      type: 'video',
      videoId: 'N-wHLE3HRYQ',
      title: 'Aleine i skauen',
      authorId: CHANNEL_ID,
      viewCount: 173,
      lengthSeconds: 239
    })
  })

  it('skips a lockup that came without a title, rather than failing the whole list', () => {
    const lockup = parseQuietly(untitled)

    // youtubei.js gives up on the metadata of a lockup with no title
    expect(lockup.metadata).toBeNull()

    expect(parseLocalPlaylistVideo(lockup)).toBeNull()
  })
})

describe('parseLocalPlaylistVideos', () => {
  it('keeps the videos it can read and drops the ones it cannot', () => {
    const videos = parseLocalPlaylistVideos([parseQuietly(untitled), parseQuietly(titled), parseQuietly(untitled)])

    expect(videos.map(video => video.videoId)).toEqual(['N-wHLE3HRYQ'])
  })
})
