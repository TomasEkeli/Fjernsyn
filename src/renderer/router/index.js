import { createRouter, createWebHashHistory } from 'vue-router'
import Subscriptions from '../views/Subscriptions/Subscriptions.vue'
import ChannelsOverview from '../views/ChannelsOverview/ChannelsOverview.vue'
import ProfileSettings from '../views/ProfileSettings/ProfileSettings.vue'
import Explore from '../views/Explore/Explore.vue'
import Popular from '../views/Popular/Popular.vue'
import UserPlaylists from '../views/UserPlaylists/UserPlaylists.vue'
import History from '../views/History/History.vue'
import Settings from '../views/Settings/Settings.vue'
import About from '../views/About/About.vue'
import LayerSearchPage from '../views/LayerSearchPage/LayerSearchPage.vue'
import Playlist from '../views/Playlist/Playlist.vue'
import Hashtag from '../views/Hashtag/Hashtag.vue'
import Post from '../views/Post.vue'
import { ChannelSurface, WatchSurface, peerTubeRoutes } from '../platform/routes'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'default',
      meta: {
        title: 'Subscriptions'
      },
      component: Subscriptions
    },
    {
      path: '/subscriptions',
      name: 'subscriptions',
      meta: {
        title: 'Subscriptions'
      },
      component: Subscriptions
    },
    {
      path: '/subscribedchannels',
      name: 'subscribedChannels',
      meta: {
        title: 'Channels'
      },
      component: ChannelsOverview
    },
    ...(process.env.SUPPORTS_LOCAL_API
      ? [{
          path: '/explore',
          // The page was called Trending for as long as YouTube had a trending
          // feed. It hasn't for a while, and the old address is in muscle
          // memory, in saved landing pages and in YouTube's own /feed/trending
          // links, so it goes on working.
          alias: '/trending',
          name: 'explore',
          meta: {
            title: 'Explore'
          },
          component: Explore
        }]
      : []),
    {
      path: '/popular',
      name: 'popular',
      meta: {
        title: 'Most Popular'
      },
      component: Popular
    },
    {
      path: '/userplaylists',
      name: 'userPlaylists',
      meta: {
        title: 'Your Playlists'
      },
      component: UserPlaylists
    },
    {
      path: '/history',
      name: 'history',
      meta: {
        title: 'History'
      },
      component: History
    },
    {
      path: '/settings',
      name: 'settings',
      meta: {
        title: 'Settings'
      },
      component: Settings
    },
    {
      path: '/about',
      name: 'about',
      meta: {
        title: 'About'
      },
      component: About
    },
    {
      path: '/settings/profile',
      name: 'profileSettings',
      meta: {
        title: 'Profile Settings'
      },
      component: ProfileSettings
    },
    {
      path: '/search/:query',
      meta: {
        title: 'Search Results'
      },
      // Fjernsyn: the layer's search page; upstream's SearchPage stays in the tree, unrouted
      component: LayerSearchPage
    },
    {
      path: '/playlist/:id',
      meta: {
        title: 'Playlist'
      },
      component: Playlist
    },
    {
      path: '/channel/:id/:currentTab?',
      meta: {
        title: 'Channel'
      },
      // Fjernsyn: upstream's Channel while enableLayerSurfaces is off, the layer's channel view while it is on
      component: ChannelSurface
    },
    {
      path: '/watch/:id',
      meta: {
        title: 'Watch'
      },
      // Fjernsyn: upstream's Watch while enableLayerSurfaces is off, the layer's watch view while it is on
      component: WatchSurface
    },
    {
      path: '/hashtag/:hashtag',
      meta: {
        title: 'Hashtag'
      },
      component: Hashtag
    },
    {
      path: '/post/:id',
      meta: {
        title: 'Post',
      },
      component: Post
    },
    ...peerTubeRoutes
  ],
  scrollBehavior(to, from, savedPosition) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (savedPosition !== null) {
          resolve(savedPosition)
        } else {
          resolve({ left: 0, top: 0 })
        }
      }, 500)
    })
  }
})

export default router
