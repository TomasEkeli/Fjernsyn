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
    <FtFlexBox class="keeperRow">
      <p class="keeperLabel">
        {{ t('Settings.Data Settings.Backup.Keeper.Keep a backup in') }}
      </p>
      <p class="keeperFolder">
        {{ keeperFolder ?? t('Settings.Data Settings.Backup.Keeper.Not set') }}
      </p>
      <FtButton
        :label="t('Settings.Data Settings.Backup.Keeper.Choose folder')"
        @click="chooseKeeperFolder"
      />
      <FtButton
        v-if="keeperFolder !== null"
        :label="t('Settings.Data Settings.Backup.Keeper.Stop keeping')"
        @click="stopKeeping"
      />
    </FtFlexBox>
    <FtFlexBox
      v-if="keeperLine !== null"
      class="keeperRow"
    >
      <p class="keeperStatus">
        {{ keeperLine.text }}
      </p>
      <FtButton
        v-for="action in keeperLine.actions"
        :key="action.answer"
        :label="action.label"
        @click="answerKeeper(action.answer)"
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
import { gunzipSync, strFromU8 } from 'fflate'

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
import { getTodayDateStrLocalTimezone, showToast, writeFileWithPicker } from '../../helpers/utils'
import { answerKeeper, chooseKeeperFolder, stopKeeping, useKeeperStatus, useKeeperWords } from '../../composables/useKeeperStatus'

/**
 * The Backup group at the top of Data settings: everything in one file, and a
 * restore that replaces each section the file holds, then relaunches. The
 * format is helpers/backup.js; the restore itself is main's (main/backup).
 * Below them the kept backup: the folder main's keeper keeps it in, and what
 * the keeper last did, with the choices a pause leaves open.
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
 * This computer's host name, from main. Only ever shown, so a backup is still
 * written without it when main cannot say.
 * @returns {Promise<string | null>}
 */
async function currentMachineName() {
  try {
    const name = await window.ftElectron.getMachineName()
    return typeof name === 'string' && name !== '' ? name : null
  } catch (error) {
    console.error('Could not get the machine name', error)
    return null
  }
}

/**
 * A backup of the app as it is now: what Export backup saves, and the safety
 * copy a restore writes first
 */
async function buildBackupText() {
  const [{ installationId, sections }, machineName] = await Promise.all([collectBackup(), currentMachineName()])

  return writeBackup({ appVersion: packageDetails.version, installationId, machineName, sections })
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

/**
 * The backup file chosen, as bytes: readFileWithPicker in helpers/utils.js
 * gives text, which a gzipped file does not survive. A gzip file is offered
 * by `.gz` alone, as a base's `.json.gz` is.
 * @returns {Promise<Uint8Array | null>} null when the picker is cancelled
 */
async function pickBackupFile() {
  let file
  try {
    /** @type {FileSystemFileHandle[]} */
    const [handle] = await window.showOpenFilePicker({
      excludeAcceptAllOption: true,
      multiple: false,
      id: IMPORT_DIRECTORY_ID,
      startIn: START_IN_DIRECTORY,
      types: [{
        description: t('Settings.Data Settings.Backup.Backup file'),
        accept: { 'application/json': ['.json'], 'application/gzip': ['.gz'] },
      }],
    })

    file = await handle.getFile()
  } catch (error) {
    // the picker was cancelled
    if (error.name === 'AbortError') {
      return null
    }

    throw error
  }

  return new Uint8Array(await file.arrayBuffer())
}

/**
 * A backup file's text, unpacked first when it is gzipped, as a base from the
 * kept backup is. Its first two bytes say so, whatever the file is called.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function backupFileText(bytes) {
  const gzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b

  return strFromU8(gzipped ? gunzipSync(bytes) : bytes)
}

async function chooseBackup() {
  let text
  try {
    const bytes = await pickBackupFile()

    if (bytes === null) {
      return
    }

    text = backupFileText(bytes)
  } catch (error) {
    showToast(`${t('Settings.Data Settings.Unable to read file')}: ${error}`)
    return
  }

  const contents = readBackup(text, {
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
    case 'noMainProfile':
      return t('Settings.Data Settings.Backup.Refused.No main profile')
    default:
      return t('Settings.Data Settings.Backup.Refused.Not a backup')
  }
}

const writtenBy = computed(() => {
  const backup = pending.value
  const { appVersion, machineName } = backup.contents.header
  const version = appVersion ?? t('Settings.Data Settings.Backup.Confirm.Unknown version')

  if (backup.sameInstallation) {
    // An older backup from here does not name the machine, and "another
    // machine" would be wrong about it
    return machineName === null
      ? t('Settings.Data Settings.Backup.Confirm.This installation', { version })
      : t('Settings.Data Settings.Backup.Confirm.This installation on machine', { version, machine: machineName })
  }

  const machine = machineName ?? t('Settings.Data Settings.Backup.Confirm.Unknown machine')

  return t('Settings.Data Settings.Backup.Confirm.Other installation', { version, machine })
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
    case 'unstorable':
      return t('Settings.Data Settings.Backup.Confirm.Left out.Unstorable', { count }, count)
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
  // A second click on Restore, before the confirmation has closed
  if (pending.value === null) {
    return
  }

  const { contents } = pending.value
  pending.value = null

  showToast(t('Settings.Data Settings.Backup.Restoring'))

  let safetyCopy
  try {
    safetyCopy = await buildBackupText()
  } catch (error) {
    showToast(t('Settings.Data Settings.Backup.Failed before writing', { error: String(error) }), LONG_TOAST_MS)
    return
  }

  let result
  try {
    result = await window.ftElectron.restoreBackup({ safetyCopy, sections: contents.sections })
  } catch (error) {
    result = { ok: false, error: String(error), safetyCopyPath: null }
  }

  // On success the app relaunches, and this window is gone. Main answers
  // nothing to a window that is not the app's, which this one always is.
  if (result != null && !result.ok) {
    const message = result.safetyCopyPath === null
      ? t('Settings.Data Settings.Backup.Failed before writing', { error: result.error })
      : t('Settings.Data Settings.Backup.Failed', { error: result.error, path: result.safetyCopyPath })

    showToast(message, LONG_TOAST_MS)
  }
}

// #endregion restore

// #region kept backup

const keeperStatus = useKeeperStatus()
const keeperWords = useKeeperWords()

/** @type {import('vue').ComputedRef<string | null>} */
const keeperFolder = computed(() => keeperStatus.value?.folder ?? null)

/**
 * @typedef KeeperLine
 * @property {string} text
 * @property {{ label: string, answer: import('../../../main/backup/keeper').KeeperAnswer }[]} actions
 */

/**
 * What the keeper last did, or why it stopped, while it keeps a folder. A
 * pause keeps its choices here, so one put off with Not now can be made later.
 * @type {import('vue').ComputedRef<KeeperLine | null>}
 */
const keeperLine = computed(() => {
  const status = keeperStatus.value

  if (status == null || status.folder === null) {
    return null
  }

  if (status.pause !== null) {
    return pauseLine(status.pause)
  }

  if (status.failure !== null) {
    return { text: t('Settings.Data Settings.Backup.Keeper.Could not write', { message: status.failure.message }), actions: [] }
  }

  return {
    text: status.writtenAt === null
      ? t('Settings.Data Settings.Backup.Keeper.Not written yet')
      : t('Settings.Data Settings.Backup.Keeper.Written', { time: keeperWords.time(status.writtenAt) }),
    actions: [],
  }
})

/**
 * @param {NonNullable<import('../../../main/backup/keeper').KeeperStatus['pause']>} pause
 * @returns {KeeperLine | null}
 */
function pauseLine(pause) {
  const overwrite = { label: t('Settings.Data Settings.Backup.Keeper.Overwrite with this data'), answer: 'overwrite' }
  const machine = keeperWords.machine(pause.machineName)
  const time = keeperWords.time(pause.writtenAt)

  switch (pause.reason) {
    case 'otherMachine':
      return {
        text: t('Settings.Data Settings.Backup.Keeper.Paused.Other machine', { machine, time }),
        actions: [{ label: t('Settings.Data Settings.Backup.Keeper.Restore relaunches'), answer: 'restore' }, overwrite],
      }
    case 'refused': {
      const reason = keeperWords.refusedReason(pause.detail)

      return {
        text: reason === null
          ? t('Settings.Data Settings.Backup.Keeper.Paused.Refused without reason')
          : t('Settings.Data Settings.Backup.Keeper.Paused.Refused', { reason }),
        actions: [overwrite],
      }
    }
    case 'newer':
      return { text: t('Settings.Data Settings.Backup.Keeper.Paused.Newer'), actions: [] }
    case 'baseMissing':
      // The notice asks Restore or Overwrite once the base arrives. Overwrite
      // is here too, as a base that never comes would otherwise leave no way out
      return { text: t('Settings.Data Settings.Backup.Keeper.Paused.Base missing', { machine, time }), actions: [overwrite] }
    default:
      return null
  }
}

// #endregion kept backup
</script>

<style scoped src="./BackupSettings.css" />
