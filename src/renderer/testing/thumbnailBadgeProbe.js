import { h, inject } from 'vue'

import { THUMBNAIL_BADGE } from '../helpers/thumbnailBadge'

/**
 * A stand-in for FtElementList that draws, for each video it is given, only
 * the thumbnail badge its wall provides (helpers/thumbnailBadge.js), as each
 * card would: so that a view's test can see the badge its cards get without
 * mounting the cards. Nothing is drawn where the wall provides none.
 *
 * @example
 * mountWithApp(View, { stubs: { FtElementList: ThumbnailBadgeProbe } })
 */
export const ThumbnailBadgeProbe = {
  name: 'ThumbnailBadgeProbe',
  props: {
    data: { type: Array, required: true },
  },
  setup(props) {
    const badge = inject(THUMBNAIL_BADGE, null)

    return () => h('div', { class: 'thumbnailBadgeProbe' }, badge === null
      ? []
      : props.data.map(video => h('div', { key: video.videoId, class: 'probeCard', 'data-video-id': video.videoId }, [h(badge, { video })])))
  },
}
