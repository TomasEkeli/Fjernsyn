<template>
  <template v-if="USING_ELECTRON">
    <h4 class="groupTitle">
      {{ t('Settings.Data Settings.Backup.Backup') }}
      <FtTooltip
        class="selectTooltip"
        position="top"
        :tooltip="t('Settings.Data Settings.Backup.Tooltip')"
      />
    </h4>
    <FtFlexBox class="backupBox">
      <FtButton
        :label="t('Settings.Data Settings.Backup.Export backup')"
        @click="exportBackup"
      />
      <FtButton
        :label="t('Settings.Data Settings.Backup.Restore backup')"
        @click="chooseBackup"
      />
    </FtFlexBox>
    <FtPrompt
      v-if="pending !== null"
      :label="t('Settings.Data Settings.Backup.Confirm.Title')"
      @click="cancel"
    >
      <div class="backupSummary">
        <p>{{ writtenBy }}</p>
        <p>{{ t('Settings.Data Settings.Backup.Confirm.Replaces') }}</p>
        <ul class="backupSections">
          <li
            v-for="line in sectionLines"
            :key="line.section"
          >
            {{ line.label }}
            <ul
              v-if="line.leftOut.length > 0"
              class="backupLeftOut"
            >
              <li
                v-for="text in line.leftOut"
                :key="text"
              >
                {{ text }}
              </li>
            </ul>
          </li>
        </ul>
        <p v-if="pending.contents.unknownSections.length > 0">
          {{ t('Settings.Data Settings.Backup.Confirm.Unknown sections', { sections: pending.contents.unknownSections.join(', ') }) }}
        </p>
        <p>{{ t('Settings.Data Settings.Backup.Confirm.Safety copy', { folder: pending.folder }) }}</p>
        <p v-if="pending.downloads.length > 0">
          {{ t('Settings.Data Settings.Backup.Confirm.Downloads', { titles: pending.downloads.join(', ') }) }}
        </p>
        <p>{{ t('Settings.Data Settings.Backup.Confirm.Restarts') }}</p>
      </div>
      <FtFlexBox>
        <FtButton
          :label="t('Settings.Data Settings.Backup.Confirm.Restore')"
          text-color="var(--destructive-text-color)"
          background-color="var(--destructive-color)"
          @click="restore"
        />
        <FtButton
          :label="t('Settings.Data Settings.Backup.Confirm.Cancel')"
          :text-color="null"
          :background-color="null"
          @click="cancel"
        />
      </FtFlexBox>
    </FtPrompt>
  </template>
</template>

<script setup>
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtPrompt from '../FtPrompt/FtPrompt.vue'
import FtTooltip from '../FtTooltip/FtTooltip.vue'

import packageDetails from '../../../../package.json'
import store from '../../store/index'
import { NON_TRANSFERABLE_SETTINGS } from '../../store/modules/settings'
import {
  DBAiVerdictHandlers,
  DBChannelHandlers,
  DBHistoryHandlers,
  DBLaterHandlers,
  DBPlaylistHandlers,
  DBProfileHandlers,
  DBSearchHistoryHandlers,
  DBSettingHandlers,
} from '../../../datastores/handlers/index'
import { BACKUP_SECTIONS, backupFileName, readBackup, writeBackup } from '../../helpers/backup'
import { listAllDownloads } from '../../helpers/downloads'
import { isRunning } from '../../helpers/ytdlpDownloads'
import { getTodayDateStrLocalTimezone, readFileWithPicker, showToast, writeFileWithPicker } from '../../helpers/utils'

/**
 * The Backup group at the top of Data settings: everything in one file, and a
 * restore that replaces each section the file holds, then relaunches. The
 * format is helpers/backup.js; the restore itself is main's (main/backup).
 */

const USING_ELECTRON = process.env.IS_ELECTRON

// As the section imports and exports in Data settings
const IMPORT_DIRECTORY_ID = 'data-settings-import'
const EXPORT_DIRECTORY_ID = 'data-settings-export'
const START_IN_DIRECTORY = 'downloads'

// Long enough to read a message with a path in it
const LONG_TOAST_MS = 15_000

const { t } = useI18n()

// #region collecting

/**
 * Every section as the datastores hold it, read through the handlers rather
 * than the Vuex stores: AI verdicts are not synced between windows, and a
 * store may hold a reduced shape.
 *
 * Settings are every setting this app knows that does not belong to the
 * machine, so that a restore makes the other side what this one is: a stored
 * one with its stored value, one never changed with its default, which is
 * what the store holds for it.
 *
 * @returns {Promise<{ installationId: string, sections: Record<string, object[]> }>}
 */
async function collectBackup() {
  const [profiles, history, playlists, later, searchHistory, storedSettings, channels, aiVerdicts] = await Promise.all([
    DBProfileHandlers.find(),
    DBHistoryHandlers.find(),
    DBPlaylistHandlers.find(),
    DBLaterHandlers.find(),
    DBSearchHistoryHandlers.find(),
    DBSettingHandlers.find(),
    DBChannelHandlers.find(),
    DBAiVerdictHandlers.find(),
  ])

  const stored = new Map(storedSettings.map(({ _id, value }) => [_id, value]))
  const current = store.state.settings

  const settings = Object.keys(current)
    .filter(id => !NON_TRANSFERABLE_SETTINGS.has(id))
    .map(id => ({ _id: id, value: stored.has(id) ? stored.get(id) : current[id] }))
    // A setting whose value is undefined would be written as a record without one
    .filter(record => record.value !== undefined)

  return {
    installationId: storedInstallationId(storedSettings),
    sections: { profiles, history, playlists, later, searchHistory, settings, channels, aiVerdicts },
  }
}

/**
 * @param {{ _id: string, value: any }[]} storedSettings
 */
function storedInstallationId(storedSettings) {
  const value = storedSettings.find(({ _id }) => _id === 'installationId')?.value
  return typeof value === 'string' ? value : ''
}

/**
 * A backup of the app as it is now: what Export backup saves, and the safety
 * copy a restore writes first
 */
async function buildBackupText() {
  const { installationId, sections } = await collectBackup()

  return writeBackup({ appVersion: packageDetails.version, installationId, sections })
}

// #endregion collecting

// #region export

async function exportBackup() {
  try {
    const text = await buildBackupText()

    const written = await writeFileWithPicker(
      backupFileName(getTodayDateStrLocalTimezone()),
      text,
      t('Settings.Data Settings.Backup.Backup file'),
      'application/json',
      '.json',
      EXPORT_DIRECTORY_ID,
      START_IN_DIRECTORY
    )

    if (written) {
      showToast(t('Settings.Data Settings.Backup.Exported'))
    }
  } catch (error) {
    showToast(`${t('Settings.Data Settings.Unable to write file')}: ${error}`)
  }
}

// #endregion export

// #region restore

/**
 * The backup chosen and read, and what the confirmation says about it, while
 * the confirmation is open
 * @type {import('vue').ShallowRef<null | {
 *   contents: import('../../helpers/backup').BackupContents,
 *   folder: string,
 *   downloads: string[],
 *   sameInstallation: boolean,
 * }>}
 */
const pending = shallowRef(null)

async function chooseBackup() {
  let response
  try {
    response = await readFileWithPicker(
      t('Settings.Data Settings.Backup.Backup file'),
      { 'application/json': '.json' },
      IMPORT_DIRECTORY_ID,
      START_IN_DIRECTORY
    )
  } catch (error) {
    showToast(`${t('Settings.Data Settings.Unable to read file')}: ${error}`)
    return
  }

  if (response === null) {
    return
  }

  const contents = readBackup(response.content, {
    knownSettings: Object.keys(store.state.settings),
    machineBoundSettings: NON_TRANSFERABLE_SETTINGS,
  })

  if (!contents.ok) {
    showToast(refusalText(contents), LONG_TOAST_MS)
    return
  }

  if (Object.keys(contents.sections).length === 0) {
    showToast(t('Settings.Data Settings.Backup.Refused.Nothing to restore'), LONG_TOAST_MS)
    return
  }

  try {
    const [folder, storedSettings, downloads] = await Promise.all([
      window.ftElectron.getBackupFolder(),
      DBSettingHandlers.find(),
      runningDownloads(),
    ])

    const installationId = storedInstallationId(storedSettings)

    pending.value = {
      contents,
      folder,
      downloads,
      sameInstallation: installationId !== '' && contents.header.installationId === installationId,
    }
  } catch (error) {
    showToast(`${t('Settings.Data Settings.Unable to read file')}: ${error}`)
  }
}

/**
 * The titles of the downloads running in main, which the relaunch stops
 * @returns {Promise<string[]>}
 */
async function runningDownloads() {
  try {
    const { downloads } = await listAllDownloads()
    return downloads.filter(isRunning).map(download => download.title)
  } catch (error) {
    console.error('Could not list the downloads', error)
    return []
  }
}

/**
 * @param {import('../../helpers/backup').BackupRefusal} refusal
 */
function refusalText(refusal) {
  switch (refusal.reason) {
    case 'notJson':
      return t('Settings.Data Settings.Backup.Refused.Not JSON')
    case 'newerVersion':
      return t('Settings.Data Settings.Backup.Refused.Newer version', { version: refusal.formatVersion })
    case 'sectionNotArray':
      return t('Settings.Data Settings.Backup.Refused.Section not a list', { section: refusal.section })
    default:
      return t('Settings.Data Settings.Backup.Refused.Not a backup')
  }
}

const writtenBy = computed(() => {
  const backup = pending.value
  const version = backup.contents.header.appVersion ?? t('Settings.Data Settings.Backup.Confirm.Unknown version')

  return backup.sameInstallation
    ? t('Settings.Data Settings.Backup.Confirm.This installation', { version })
    : t('Settings.Data Settings.Backup.Confirm.Other installation', { version })
})

/** @type {import('vue').ComputedRef<Record<string, string>>} */
const sectionLabels = computed(() => ({
  profiles: t('Settings.Data Settings.Backup.Sections.Profiles'),
  history: t('Settings.Data Settings.Backup.Sections.History'),
  playlists: t('Settings.Data Settings.Backup.Sections.Playlists'),
  later: t('Settings.Data Settings.Backup.Sections.Later'),
  searchHistory: t('Settings.Data Settings.Backup.Sections.Search history'),
  settings: t('Settings.Data Settings.Backup.Sections.Settings'),
  channels: t('Settings.Data Settings.Backup.Sections.Channels'),
  aiVerdicts: t('Settings.Data Settings.Backup.Sections.AI verdicts'),
}))

/**
 * @param {import('../../helpers/backup').LeftOutReason} reason
 * @param {number} count
 */
function leftOutText(reason, count) {
  switch (reason) {
    case 'invalidPeerTube':
      return t('Settings.Data Settings.Backup.Confirm.Left out.Invalid PeerTube', { count }, count)
    case 'duplicate':
      return t('Settings.Data Settings.Backup.Confirm.Left out.Duplicate', { count }, count)
    case 'unknownSetting':
      return t('Settings.Data Settings.Backup.Confirm.Left out.Unknown setting', { count }, count)
    case 'machineBound':
      return t('Settings.Data Settings.Backup.Confirm.Left out.Machine-bound setting', { count }, count)
    case 'playlistVideos':
      return t('Settings.Data Settings.Backup.Confirm.Left out.Playlist videos', { count }, count)
    default:
      return t('Settings.Data Settings.Backup.Confirm.Left out.Missing fields', { count }, count)
  }
}

/** Each section the backup holds, in the backup's order, with its count and what is left out */
const sectionLines = computed(() => {
  const { counts } = pending.value.contents

  return BACKUP_SECTIONS
    .filter(section => counts[section] !== undefined)
    .map(section => ({
      section,
      label: t('Settings.Data Settings.Backup.Confirm.Section count', { section: sectionLabels.value[section], count: counts[section].kept }),
      leftOut: Object.entries(counts[section].leftOut).map(([reason, count]) => leftOutText(reason, count)),
    }))
})

function cancel() {
  pending.value = null
}

async function restore() {
  const { contents } = pending.value
  pending.value = null

  let safetyCopy
  try {
    safetyCopy = await buildBackupText()
  } catch (error) {
    showToast(t('Settings.Data Settings.Backup.Failed before writing', { error: String(error) }), LONG_TOAST_MS)
    return
  }

  const result = await window.ftElectron.restoreBackup({ safetyCopy, sections: contents.sections })

  // On success the app relaunches, and this window is gone
  if (result != null && !result.ok) {
    const message = result.safetyCopyPath === null
      ? t('Settings.Data Settings.Backup.Failed before writing', { error: result.error })
      : t('Settings.Data Settings.Backup.Failed', { error: result.error, path: result.safetyCopyPath })

    showToast(message, LONG_TOAST_MS)
  }
}

// #endregion restore
</script>

<style scoped src="./BackupSettings.css" />
