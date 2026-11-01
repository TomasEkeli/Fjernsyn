/**
 * Shares, and the wall made of them.
 *
 * A share is one occurrence of a video in a source (see `hackertube.js` for
 * its shape). A video shared by three sources has three shares and is one
 * card on a wall: shares are keyed by source and video ref, and the wall
 * groups them by the video ref alone.
 *
 * Framework-free and import-free, so that the build script can run it in
 * Node as it is.
 */

/**
 * @typedef {{ videoId: string, host?: string }} VideoRef a YouTube video's id,
 *   or a PeerTube video's uuid with its origin host
 */

/**
 * The video's ref as one string: the video id, and for PeerTube `@` and its
 * origin host.
 *
 * @param {VideoRef} ref
 * @returns {string}
 */
export function shareVideoKey(ref) {
  return typeof ref.host === 'string' && ref.host !== '' ? `${ref.videoId}@${ref.host}` : ref.videoId
}

/**
 * A share's id: its source's id and its video's ref, one share per source
 * per video.
 *
 * @param {string} sourceId
 * @param {VideoRef} ref
 * @returns {string}
 */
export function shareId(sourceId, ref) {
  return `${sourceId}|${shareVideoKey(ref)}`
}

/**
 * @typedef {object} CollectionVideo a video on a collections wall: an
 *   ordinary video object, which every card action understands, with what its
 *   shares say about it under `collection`
 * @property {'video'} type
 * @property {string} videoId
 * @property {string} title
 * @property {string} author
 * @property {''} lengthSeconds unknown until the details arrive; `''` and not
 *   undefined, which the card would take for a live stream
 * @property {'peertube'} [platform]
 * @property {string} [host]
 * @property {{ votes: number | null, sharedAt: number | null, sourceIds: string[] }} collection
 */

/**
 * @param {number | null} a
 * @param {number | null} b
 * @returns {number} most first, nothing last
 */
function mostFirst(a, b) {
  if (a === b) { return 0 }
  if (a === null) { return 1 }
  if (b === null) { return -1 }
  return b - a
}

/**
 * The wall: one video per video ref among the shares given, with the votes
 * of those shares summed and the latest of their dates, ordered by votes,
 * most first. A video no share voted on comes after every one that has
 * votes. Ties go to the latest shared, then to the video id, so that the
 * order is the same every time.
 *
 * The shares given are the ones that count: the caller decides which sources
 * are shown.
 *
 * @param {import('./hackertube').Share[]} shares
 * @returns {CollectionVideo[]}
 */
export function wallVideos(shares) {
  /** @type {Map<string, CollectionVideo>} */
  const byVideo = new Map()

  for (const share of shares) {
    const key = shareVideoKey(share)
    let video = byVideo.get(key)

    if (video === undefined) {
      video = {
        type: 'video',
        videoId: share.videoId,
        title: '',
        author: '',
        lengthSeconds: '',
        collection: { votes: null, sharedAt: null, sourceIds: [] },
      }

      if (share.platform === 'peertube') {
        video.platform = 'peertube'
        video.host = share.host
      }

      byVideo.set(key, video)
    }

    if (video.title === '' && typeof share.title === 'string') { video.title = share.title }
    if (video.author === '' && typeof share.author === 'string') { video.author = share.author }

    const { collection } = video

    if (typeof share.votes === 'number') {
      collection.votes = (collection.votes ?? 0) + share.votes
    }

    if (typeof share.sharedAt === 'number' && (collection.sharedAt === null || share.sharedAt > collection.sharedAt)) {
      collection.sharedAt = share.sharedAt
    }

    if (!collection.sourceIds.includes(share.sourceId)) {
      collection.sourceIds.push(share.sourceId)
    }
  }

  return [...byVideo.values()].sort((a, b) => {
    return mostFirst(a.collection.votes, b.collection.votes) ||
      mostFirst(a.collection.sharedAt, b.collection.sharedAt) ||
      (a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0)
  })
}
