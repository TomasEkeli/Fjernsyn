// The PeerTube section for the settings page, which spreads this in with one
// line (views/Settings/Settings.vue). PeerTube is Electron-only, and the
// section is there only while the experimental setting is on; read inside the
// page's computed, so the section comes and goes with the setting.

import PeerTubeSettings from './PeerTubeSettings.vue'

import store from '../../store/index'

/**
 * @param {(key: string) => string} t
 * @returns {{ type: string, title: string, icon: string[], component: import('vue').Component }[]}
 */
export function peerTubeSettingsSections(t) {
  if (!process.env.IS_ELECTRON || !store.getters.getEnablePeerTube) {
    return []
  }

  return [{
    type: 'peertube',
    title: t('PeerTube.Settings.PeerTube Settings'),
    icon: ['fas', 'globe'],
    component: PeerTubeSettings
  }]
}
