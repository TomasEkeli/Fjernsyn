import { uniqueIcons } from '../../helpers/profilePictures'

/** @import { PickerIcon } from '../../helpers/profilePictures' */

/**
 * The icons being loaded, or loaded. A load that failed is forgotten, so
 * that the next time the Icon panel opens it is tried again.
 * @type {Promise<PickerIcon[]> | null}
 */
let loading = null

/**
 * Every icon of Font Awesome's solid pack, loaded the first time it is asked
 * for, as a chunk of its own, and kept for the session. Only the picker needs
 * the pack: a chosen icon is stored with its path, so drawing one does not.
 * @returns {Promise<PickerIcon[]>}
 */
export function loadIcons() {
  loading ??= import(/* webpackChunkName: "icons-solid" */ '@fortawesome/free-solid-svg-icons')
    .then(pack => uniqueIcons(pack))
    .catch((error) => {
      loading = null
      throw error
    })

  return loading
}
