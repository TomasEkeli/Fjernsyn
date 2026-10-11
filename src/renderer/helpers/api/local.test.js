import { describe, expect, it, vi } from 'vitest'
import { Parser, YTNodes } from 'youtubei.js'

import { extractLocalContentDisclosures, parseLocalPlaylistVideo, parseLocalPlaylistVideos } from './local'

import madeWithAi from '../aiMarker/fixtures/local--next-made-with-ai.json'
import autoDubbed from '../aiMarker/fixtures/local--next-auto-dubbed.json'
import ordinary from '../aiMarker/fixtures/local--next-ordinary.json'

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

// The WEB client's /next, as the watch page has it, from the AI marker's
// fixtures: only the engagement panels are kept in them, so only they are
// parsed, into the page `getLocalVideoInfo` gives `VideoInfo` second.
describe('extractLocalContentDisclosures', () => {
  /** @param {{ answer: { engagementPanels: unknown[] } }} fixture */
  function infoOf(fixture) {
    return { page: [null, Parser.parseResponse({ engagementPanels: fixture.answer.engagementPanels })] }
  }

  /**
   * The "How this was made" section's view model in a fixture, to reword
   * @param {any} node
   * @returns {any}
   */
  function sectionIn(node) {
    if (node === null || typeof node !== 'object') { return null }
    if (node.howThisWasMadeSectionViewModel) { return node.howThisWasMadeSectionViewModel }

    for (const child of Object.values(node)) {
      const found = sectionIn(child)
      if (found) { return found }
    }

    return null
  }

  it('reads the "Made with AI" disclosure, its "Learn more" a link to YouTube\'s help page', () => {
    expect(extractLocalContentDisclosures(infoOf(madeWithAi))).toEqual([{
      label: 'Made with AI',
      description: 'Sounds or visuals were altered or fully generated.',
      link: { text: 'Learn more', url: 'https://support.google.com/youtube/answer/15447836?hl=en' },
      attribution: '',
    }])
  })

  // The words, and the link's place in them, as YouTube sent them in
  // Norwegian (aiMarker/fixtures/local--next-made-with-ai-mweb-nb.json, an
  // MWEB answer, which youtubei.js cannot read this section from), put into
  // the WEB answer's section
  it('finds the link by where it is, not by its words, in any interface language', () => {
    const norwegian = structuredClone(madeWithAi)
    const section = sectionIn(norwegian.answer.engagementPanels)
    const helpUrl = '//support.google.com/youtube/answer/15447836?hl=no'
    section.bodyHeader.content = 'Laget med AI'
    section.bodyText.content = 'Lyden eller grafikken er modifisert eller generert med AI. Finn ut mer'
    section.bodyText.commandRuns[0].startIndex = 59
    section.bodyText.commandRuns[0].length = 11
    section.bodyText.commandRuns[0].onTap.innertubeCommand.commandMetadata.webCommandMetadata.url = helpUrl
    section.bodyText.commandRuns[0].onTap.innertubeCommand.urlEndpoint.url = helpUrl
    section.bodyText.styleRuns = [{ ...section.bodyText.styleRuns[0], startIndex: 59, length: 11 }]

    expect(extractLocalContentDisclosures(infoOf(norwegian))).toEqual([{
      label: 'Laget med AI',
      description: 'Lyden eller grafikken er modifisert eller generert med AI.',
      link: { text: 'Finn ut mer', url: 'https://support.google.com/youtube/answer/15447836?hl=no' },
      attribution: '',
    }])
  })

  it('keeps the whole body as text when it has no link', () => {
    const unlinked = structuredClone(madeWithAi)
    const section = sectionIn(unlinked.answer.engagementPanels)
    delete section.bodyText.commandRuns
    delete section.bodyText.styleRuns

    expect(extractLocalContentDisclosures(infoOf(unlinked))[0]).toMatchObject({
      description: 'Sounds or visuals were altered or fully generated. Learn more',
      link: null,
    })
  })

  // Shown as YouTube words it; that it is not an AI video is the AI label's to say
  it('reads an "Auto-dubbed" disclosure as well', () => {
    expect(extractLocalContentDisclosures(infoOf(autoDubbed))).toEqual([{
      label: 'Auto-dubbed',
      description: 'Audio tracks for some languages were automatically generated.',
      link: { text: 'Learn more', url: 'https://support.google.com/youtube/answer/15569972?hl=en' },
      attribution: '',
    }])
  })

  it('is none for a video without the section', () => {
    expect(extractLocalContentDisclosures(infoOf(ordinary))).toBeNull()
  })
})
