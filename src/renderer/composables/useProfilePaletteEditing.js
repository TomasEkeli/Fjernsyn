import { computed, nextTick, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { MAIN_PROFILE_ID } from '../../constants'
import store from '../store/index'
import { calculateColorLuminance, colors } from '../helpers/colors'
import { moveInOrder, pickUnusedColour, profileOrderIds } from '../helpers/channelsOverview'
import { readProfilePicture } from '../helpers/profilePictures'
import { getFirstCharacter } from '../helpers/strings'
import { deepCopy, showToast } from '../helpers/utils'

/** @import { Profile } from '../helpers/channelsOverview' */
/** @import { ProfilePicture } from '../helpers/profilePictures' */

const COLOUR_VALUES = colors.map(colour => colour.value)

/**
 * @param {FocusOptions} [options]
 */
function focusNewProfile(options) {
  document.querySelector('.palette .newProfile')?.focus(options)
}

/**
 * Puts the focus on a profile's bubble in the palette, or on New profile
 * when it has none, as a profile deleted in another window no longer does:
 * the focus would otherwise fall to the page itself.
 * @param {string} profileId
 * @param {FocusOptions} [options]
 */
export function focusBubble(profileId, options) {
  const bubble = document.querySelector(`.palette [data-profile-id="${CSS.escape(profileId)}"] [role="button"]`)

  if (bubble) {
    bubble.focus(options)
  } else {
    focusNewProfile(options)
  }
}

/**
 * Making, renaming, recolouring, picturing and reordering profiles from the
 * palette on the Channels page. The palette says what was done to it; this
 * works out what that means for the store, and holds what is half done: a new
 * profile being named, a profile being renamed, a menu open over a bubble.
 *
 * @param {object} options
 * @param {import('vue').ComputedRef<Profile[]>} options.profileList every profile, in order
 * @param {<T>(change: () => Promise<T>) => Promise<T>} options.afterPendingChanges the page's queue of profile writes
 * @param {(profileId: string) => void} options.openColumn
 */
export function useProfilePaletteEditing({ profileList, afterPendingChanges, openColumn }) {
  const { locale, t } = useI18n()

  /**
   * The new profile being named, at the end of the palette. Null while there
   * is none; never more than one.
   * @type {import('vue').Ref<{ bgColor: string, saving: boolean } | null>}
   */
  const draft = ref(null)

  function startDraft() {
    // Never a second one: back to the first. Its field is the palette's own
    // child, where a rename's is inside its bubble.
    if (draft.value !== null) {
      document.querySelector('.palette > .nameField input:enabled')?.focus()
      return
    }

    draft.value = { bgColor: pickUnusedColour(COLOUR_VALUES, profileList.value), saving: false }
  }

  function cancelDraft() {
    if (draft.value?.saving) { return }

    draft.value = null
  }

  /**
   * @param {string} name
   * @param {boolean} hadFocus
   */
  async function commitDraft(name, hadFocus) {
    if (draft.value === null || draft.value.saving) { return }

    const { bgColor } = draft.value
    draft.value = { bgColor, saving: true }

    const created = await store.dispatch('createProfile', {
      name,
      bgColor,
      textColor: calculateColorLuminance(bgColor),
      subscriptions: []
    })

    // Gone whether it worked or not: a draft stuck saving could never be
    // given up
    draft.value = null

    if (!created) {
      // The field the focus was in has gone with it
      if (hadFocus) {
        await nextTick()
        focusNewProfile()
      }

      return
    }

    showToast(t('Profile.Profile has been created'))
    openColumn(created._id)

    // Only when the name was finished in the field: one finished by clicking
    // somewhere else leaves the focus where that click put it
    if (hadFocus) {
      await nextTick()
      focusBubble(created._id)
    }
  }

  /** @type {import('vue').Ref<string | null>} */
  const renamingProfileId = ref(null)

  /**
   * Saves a change to one profile, shown at once and then written, as a drop
   * is. In the page's queue, and reading the profile when its turn comes: the
   * whole profile is written, subscriptions and all, and one read before an
   * earlier drop had landed would put back what the drop changed.
   * @param {string} profileId
   * @param {Partial<Profile>} changes
   * @returns {Promise<void>}
   */
  function saveProfile(profileId, changes) {
    return afterPendingChanges(async () => {
      const profile = profileList.value.find(candidate => candidate._id === profileId)

      if (!profile) { return }

      const saved = { ...deepCopy(profile), ...changes }

      store.commit('upsertProfileToList', deepCopy(saved))
      await store.dispatch('updateProfile', saved)
    })
  }

  /**
   * @param {string} profileId
   * @param {string | null} name null when it was given up
   */
  async function finishRename(profileId, name) {
    renamingProfileId.value = null

    const profile = profileList.value.find(candidate => candidate._id === profileId)

    if (name === null || !profile || name === profile.name) { return }

    await saveProfile(profileId, { name })

    // A profile the order does not name sorts by its name, so a new one can
    // move its bubble, and a moved element loses the focus the bubble took
    // back when the field closed. Only then: focus anywhere else was put
    // there since, and stays.
    await nextTick()

    if (document.activeElement === null || document.activeElement === document.body) {
      focusBubble(profileId)
    }
  }

  /**
   * The menu a right-click on a bubble opens. Null while it is closed.
   * @type {import('vue').ShallowRef<{ profileId: string, name: string, anchor: object } | null>}
   */
  const profileMenu = shallowRef(null)

  /**
   * @param {string} profileId
   * @param {{ rect: DOMRect } | { x: number, y: number }} anchor
   */
  function openProfileMenu(profileId, anchor) {
    const profile = profileList.value.find(candidate => candidate._id === profileId)

    if (profile) {
      profileMenu.value = { profileId, name: profile.name, anchor }
    }
  }

  const profileMenuItems = computed(() => [
    { value: 'rename', label: t('Channels.Overview.Rename Profile') },
    { value: 'colour', label: t('Channels.Overview.Change Profile Colour') },
    { value: 'picture', label: t('Channels.Overview.Change Profile Picture') },
    { value: 'remove', label: t('Channels.Overview.Remove Profile'), destructive: true }
  ])

  /**
   * Where a menu over a profile's bubble opens: beside the bubble, wherever
   * the one it was chosen from was.
   * @param {string} profileId
   * @returns {{ rect: DOMRect } | null} null when the bubble is gone
   */
  function bubbleAnchor(profileId) {
    const bubble = document.querySelector(`.palette [data-profile-id="${CSS.escape(profileId)}"]`)

    return bubble ? { rect: bubble.getBoundingClientRect() } : null
  }

  /**
   * @param {string} value
   */
  function chooseFromProfileMenu(value) {
    if (profileMenu.value === null) { return }

    const { profileId } = profileMenu.value

    if (value === 'rename') {
      renamingProfileId.value = profileId
    } else if (value === 'colour') {
      const profile = profileList.value.find(candidate => candidate._id === profileId)
      const anchor = bubbleAnchor(profileId)

      if (profile && anchor) {
        colourMenu.value = { profileId, name: profile.name, bgColor: profile.bgColor, anchor }
      }
    } else if (value === 'picture') {
      const profile = profileList.value.find(candidate => candidate._id === profileId)
      const anchor = bubbleAnchor(profileId)

      if (profile && anchor) {
        pictureMenu.value = {
          profileId,
          name: profile.name,
          initial: getFirstCharacter(profile.name, locale.value),
          picture: readProfilePicture(store.getters.getProfilePictures, profileId),
          anchor
        }
      }
    } else if (value === 'remove') {
      const profile = profileList.value.find(candidate => candidate._id === profileId)

      if (profile) {
        removeProfile(profileId, profile.name)
      }
    }
  }

  /**
   * @param {boolean} returnFocus
   */
  function closeProfileMenu(returnFocus) {
    const profileId = profileMenu.value?.profileId
    profileMenu.value = null

    if (returnFocus && profileId) {
      focusBubble(profileId)
    }
  }

  /**
   * The colour grid over a bubble. Null while it is closed.
   * @type {import('vue').ShallowRef<{ profileId: string, name: string, bgColor: string, anchor: object } | null>}
   */
  const colourMenu = shallowRef(null)

  /**
   * @param {string} bgColor
   */
  function chooseColour(bgColor) {
    const profileId = colourMenu.value?.profileId

    if (profileId) {
      saveProfile(profileId, { bgColor, textColor: calculateColorLuminance(bgColor) })
    }
  }

  /**
   * @param {boolean} returnFocus
   */
  function closeColourMenu(returnFocus) {
    const profileId = colourMenu.value?.profileId
    colourMenu.value = null

    if (returnFocus && profileId) {
      focusBubble(profileId)
    }
  }

  /**
   * The picture picker over a bubble. Null while it is closed.
   * @type {import('vue').ShallowRef<{ profileId: string, name: string, initial: string, picture: ProfilePicture | null, anchor: object } | null>}
   */
  const pictureMenu = shallowRef(null)

  /**
   * Saved at once, as a colour is. A setting and not the profile, so it does
   * not wait on the queue of profile writes.
   * @param {ProfilePicture | null} picture null for the letter
   */
  function choosePicture(picture) {
    const profileId = pictureMenu.value?.profileId

    if (profileId) {
      // The menu can stay open after a pick, and shows it as the current one
      pictureMenu.value = { ...pictureMenu.value, picture }
      store.dispatch('saveProfilePicture', { profileId, picture })
    }
  }

  /**
   * @param {boolean} returnFocus false when closed by something outside it:
   *   the focus going elsewhere, a click, a scroll
   */
  function closePictureMenu(returnFocus) {
    const profileId = pictureMenu.value?.profileId
    pictureMenu.value = null

    if (!profileId) { return }

    if (returnFocus) {
      focusBubble(profileId)
      return
    }

    // The focus was in the menu, which is gone. Back to the bubble, unless
    // what closed it put the focus somewhere, as a click on a control does;
    // looked at once that click has done so, and without scrolling the page
    // back to the bubble after a scroll closed it.
    setTimeout(() => {
      if (document.activeElement === null || document.activeElement === document.body) {
        focusBubble(profileId, { preventScroll: true })
      }
    })
  }

  /**
   * Removes a profile at once, without asking: nothing is lost with it, as
   * its channels stay subscribed to, and those in no other profile are
   * unassigned again, which the pool shows by itself. As Profile settings
   * does, the active and default profile fall back to the primary one if it
   * was either. In the page's queue, as a drop saved after the removal would
   * bring the profile back.
   * @param {string} profileId
   * @param {string} name
   */
  async function removeProfile(profileId, name) {
    const removed = await afterPendingChanges(async () => {
      if (!profileList.value.some(candidate => candidate._id === profileId)) { return false }

      if (store.getters.getActiveProfile?._id === profileId) {
        store.dispatch('updateActiveProfile', MAIN_PROFILE_ID)
      }

      await store.dispatch('removeProfile', profileId)

      return true
    })

    if (!removed) { return }

    showToast(t('Profile.Removed {profile} from your profiles', { profile: name }))

    if (store.getters.getDefaultProfile === profileId) {
      store.dispatch('updateDefaultProfile', MAIN_PROFILE_ID)
      showToast(t('Profile.Your default profile has been changed to your primary profile'))
    }

    // The menu gave the focus back to the bubble, which is gone
    await nextTick()

    if (document.activeElement === null || document.activeElement === document.body) {
      focusNewProfile()
    }
  }

  /**
   * Puts a profile somewhere else in the order: on screen at once, then
   * saved. The order is a setting and not a profile, so it does not wait on
   * the queue of profile writes. Through saveProfileOrder rather than the
   * generated updater, whose late commit would undo a quick second move.
   * @param {string} profileId
   * @param {number} toIndex its place in the order without it
   */
  function reorder(profileId, toIndex) {
    const current = profileOrderIds(profileList.value)
    const next = moveInOrder(current, profileId, toIndex)

    if (next === current) { return }

    store.dispatch('saveProfileOrder', next)
  }

  return {
    draft,
    startDraft,
    commitDraft,
    cancelDraft,
    renamingProfileId,
    saveProfile,
    finishRename,
    profileMenu,
    profileMenuItems,
    openProfileMenu,
    chooseFromProfileMenu,
    closeProfileMenu,
    colourMenu,
    chooseColour,
    closeColourMenu,
    pictureMenu,
    choosePicture,
    closePictureMenu,
    reorder
  }
}
