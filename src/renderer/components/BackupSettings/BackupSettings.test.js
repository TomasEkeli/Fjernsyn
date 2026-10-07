import { flushPromises } from '@vue/test-utils'
import { gzipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import packageDetails from '../../../../package.json'
import store from '../../store/index'
import { listAllDownloads } from '../../helpers/downloads'
import { showToast, writeFileWithPicker } from '../../helpers/utils'
import { mountWithApp } from '../../testing/mount'
import BackupSettings from './BackupSettings.vue'

// The Backup group, with the pickers, the datastores and main stubbed: what
// an export writes, and what a restore shows and sends

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      state: {
        // what the settings module holds: the stored value, or the default
        settings: {
          maxVolume: 1000,
          baseTheme: 'dark',
          proxyHostname: '127.0.0.1',
          installationId: 'this-installation',
          profileOrder: [],
        },
      },
    }),
  }
})

vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

vi.mock('../../../datastores/handlers/index', () => {
  const handler = () => ({ find: vi.fn(async () => []) })
  return {
    DBAiVerdictHandlers: handler(),
    DBChannelHandlers: handler(),
    DBHistoryHandlers: handler(),
    DBLaterHandlers: handler(),
    DBPlaylistHandlers: handler(),
    DBProfileHandlers: handler(),
    DBSearchHistoryHandlers: handler(),
    DBSettingHandlers: handler(),
  }
})

vi.mock('../../helpers/downloads', () => ({
  listAllDownloads: vi.fn(async () => ({ downloads: [], finished: {} })),
}))

vi.mock('../../helpers/utils', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn(),
  writeFileWithPicker: vi.fn(async () => true),
  getTodayDateStrLocalTimezone: () => '2026-10-04',
}))

const MAIN_PROFILE = { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [{ id: 'UCa', name: 'A', thumbnail: null }] }
const HISTORY = { _id: 'h1', videoId: 'dQw4w9WgXcQ', title: 'T', author: 'A', authorId: 'UCa', published: 1, description: '', lengthSeconds: 1, watchProgress: 0, timeWatched: 2, isLive: false, type: 'video' }
const VERDICT = { _id: 'dQw4w9WgXcQ', ai: false, checkedAt: 3 }
const CHANNEL = { _id: 'UCa', channelTags: ['x'] }

const STORED_SETTINGS = [
  { _id: 'maxVolume', value: 1000 },
  { _id: 'baseTheme', value: 'dark' },
  { _id: 'proxyHostname', value: '10.0.0.1' },
  { _id: 'installationId', value: 'this-installation' },
  // a row no setting reads any more
  { _id: 'hideTrendingVideos', value: true },
]

const BACKUP_FOLDER = '/home/me/.config/Fjernsyn/backups'

const MACHINE_NAME = 'synthetic-desktop'

const KEPT_FOLDER = '/home/me/Sync/fjernsyn'

/** @type {import('../../../main/backup/keeper').KeeperStatus} */
const NOT_KEEPING = { folder: null, ready: true, writtenAt: null, failure: null, pause: null, arriving: null, tookIn: null }

/** The keeper keeping KEPT_FOLDER, with what the test gives it */
const keeping = (fields = {}) => ({ ...NOT_KEEPING, folder: KEPT_FOLDER, ...fields })

/**
 * A backup file's text, written by another installation on another machine
 * unless the header says otherwise
 * @param {Record<string, any>} sections
 * @param {Record<string, any>} [header]
 */
function backupFile(sections, header = {}) {
  return JSON.stringify({ format: 'fjernsyn-backup', formatVersion: 1, appVersion: '0.1.200', installationId: 'other-installation', machineName: 'synthetic-laptop', ...header, sections })
}

beforeEach(() => {
  document.body.innerHTML = '<div class="app"></div>'
  vi.mocked(showToast).mockClear()
  vi.mocked(writeFileWithPicker).mockClear()
  vi.mocked(listAllDownloads).mockResolvedValue({ downloads: [], finished: {} })

  DBProfileHandlers.find.mockResolvedValue([MAIN_PROFILE])
  DBHistoryHandlers.find.mockResolvedValue([HISTORY])
  DBPlaylistHandlers.find.mockResolvedValue([])
  DBLaterHandlers.find.mockResolvedValue([])
  DBSearchHistoryHandlers.find.mockResolvedValue([])
  DBSettingHandlers.find.mockResolvedValue(STORED_SETTINGS)
  DBChannelHandlers.find.mockResolvedValue([CHANNEL])
  DBAiVerdictHandlers.find.mockResolvedValue([VERDICT])

  window.ftElectron = {
    getBackupFolder: vi.fn(async () => BACKUP_FOLDER),
    getMachineName: vi.fn(async () => MACHINE_NAME),
    restoreBackup: vi.fn(async () => ({ ok: true, safetyCopyPath: `${BACKUP_FOLDER}/before-restore-2026-10-04-163005.json` })),
    getKeeperStatus: vi.fn(async () => NOT_KEEPING),
    handleKeeperStatus: vi.fn(),
    chooseKeeperFolder: vi.fn(async () => NOT_KEEPING),
    stopKeeping: vi.fn(async () => NOT_KEEPING),
    answerKeeper: vi.fn(async () => NOT_KEEPING),
  }
})

afterEach(() => {
  delete window.ftElectron
  delete window.showOpenFilePicker
})

/**
 * Stands in for the open file picker, with the file the user chooses in it
 * @param {string | Uint8Array | null} file the file's text or bytes; null cancels the picker
 */
function pickFile(file) {
  window.showOpenFilePicker = vi.fn(async () => {
    if (file === null) {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }

    const bytes = typeof file === 'string' ? strToU8(file) : file

    return [{
      getFile: async () => ({
        name: 'fjernsyn-backup-2026-10-01.json',
        arrayBuffer: async () => bytes.slice().buffer,
      }),
    }]
  })
}

function mountBackup() {
  return mountWithApp(BackupSettings, { store })
}

function button(wrapper, label) {
  const found = wrapper.findAll('button').find(candidate => candidate.text() === label)
  if (!found) {
    throw new Error(`no button "${label}"`)
  }
  return found
}

/** The confirmation, which is teleported into the app's root */
function confirmation() {
  return document.querySelector('.app .prompt')
}

function confirmationButton(label) {
  return [...confirmation().querySelectorAll('button')].find(candidate => candidate.textContent.trim() === label)
}

function toasts() {
  return vi.mocked(showToast).mock.calls.map(([message]) => message)
}

async function exportBackup() {
  const wrapper = mountBackup()
  await button(wrapper, 'Export backup').trigger('click')
  await flushPromises()

  expect(writeFileWithPicker).toHaveBeenCalledTimes(1)
  const [fileName, content, , mimeType, extension] = vi.mocked(writeFileWithPicker).mock.calls[0]
  return { fileName, document: JSON.parse(content), content, mimeType, extension }
}

async function chooseBackup(file) {
  pickFile(file)
  const wrapper = mountBackup()
  await button(wrapper, 'Restore backup').trigger('click')
  await flushPromises()
  return wrapper
}

describe('the Backup group', () => {
  it('offers Export backup and Restore backup', () => {
    const wrapper = mountBackup()

    expect(wrapper.text()).toContain('Backup')
    expect(button(wrapper, 'Export backup').exists()).toBe(true)
    expect(button(wrapper, 'Restore backup').exists()).toBe(true)
  })

  describe('Export backup', () => {
    it('writes what the datastores hold, as a JSON file named by the date', async () => {
      const { fileName, document, mimeType, extension } = await exportBackup()

      expect(fileName).toBe('fjernsyn-backup-2026-10-04.json')
      expect(mimeType).toBe('application/json')
      expect(extension).toBe('.json')
      expect(document.format).toBe('fjernsyn-backup')
      expect(document.appVersion).toBe(packageDetails.version)
      expect(document.installationId).toBe('this-installation')
      expect(document.machineName).toBe(MACHINE_NAME)
      expect(document.sections.profiles).toEqual([MAIN_PROFILE])
      expect(document.sections.history).toEqual([HISTORY])
      expect(document.sections.channels).toEqual([CHANNEL])
      expect(document.sections.aiVerdicts).toEqual([VERDICT])
      expect(document.sections.playlists).toEqual([])
      expect(toasts()).toEqual(['The backup has been written'])
    })

    it('writes every setting this app knows, without the machine-bound ones or rows nothing reads', async () => {
      const { document } = await exportBackup()

      expect(document.sections.settings).toEqual([
        { _id: 'baseTheme', value: 'dark' },
        { _id: 'maxVolume', value: 1000 },
        // never changed, so not stored: the default the store holds
        { _id: 'profileOrder', value: [] },
      ])
    })

    it('leaves out the subscription cache', async () => {
      const { document } = await exportBackup()

      expect(Object.keys(document.sections)).toEqual(['profiles', 'history', 'playlists', 'later', 'searchHistory', 'settings', 'channels', 'aiVerdicts'])
    })

    it('still writes the backup when main cannot say the machine name, without one', async () => {
      window.ftElectron.getMachineName.mockRejectedValue(new Error('no handler'))
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { document } = await exportBackup()

      expect(document.machineName).toBeNull()
      expect(document.sections.profiles).toEqual([MAIN_PROFILE])
      expect(toasts()).toEqual(['The backup has been written'])
      consoleError.mockRestore()
    })

    it('says nothing when the save is cancelled', async () => {
      vi.mocked(writeFileWithPicker).mockResolvedValueOnce(false)

      await exportBackup()

      expect(toasts()).toEqual([])
    })
  })

  describe('Restore backup', () => {
    it('shows a refusal with its reason, and sends nothing', async () => {
      const refusals = [
        ['not json', 'This file is not a backup: it is not JSON'],
        ['{"_id":"maxVolume","value":1}', 'This file is not a Fjernsyn backup'],
        [backupFile({}, { formatVersion: 7 }), 'This backup was written by a newer version of Fjernsyn (backup format 7), which this version cannot read'],
        [backupFile({ profiles: {} }), 'This backup cannot be read: its section "profiles" is not a list'],
        [backupFile({ bookmarks: [] }), 'This backup holds nothing this version of Fjernsyn can restore'],
        [backupFile({ profiles: [{ ...MAIN_PROFILE, _id: 'art' }] }), 'This backup cannot be restored, as its profiles do not include All Channels, which holds every subscription'],
      ]

      for (const [file, message] of refusals) {
        vi.mocked(showToast).mockClear()
        const wrapper = await chooseBackup(file)

        expect(toasts()).toEqual([message])
        expect(confirmation()).toBeNull()
        wrapper.unmount()
      }

      expect(window.ftElectron.restoreBackup).not.toHaveBeenCalled()
    })

    it('does nothing when no file is chosen', async () => {
      await chooseBackup(null)

      expect(confirmation()).toBeNull()
      expect(toasts()).toEqual([])
    })

    it('shows what the backup holds, what is left out and where the safety copy goes', async () => {
      await chooseBackup(backupFile({
        profiles: [MAIN_PROFILE],
        history: [HISTORY, { ...HISTORY, _id: 'h2', videoId: 'noTitle' + 'xxxx', title: undefined }, { videoId: 'x' }],
        settings: [{ _id: 'maxVolume', value: 300 }, { _id: 'proxyHostname', value: '10.0.0.9' }, { _id: 'notASetting', value: 1 }],
        watchParties: [],
      }))

      const text = confirmation().textContent
      expect(text).toContain('Restore this backup?')
      expect(text).toContain('Written by Fjernsyn 0.1.200 on synthetic-laptop.')
      expect(text).toContain('Each section below replaces what is here now.')
      expect(text).toContain('Profiles and subscriptions: 1')
      expect(text).toContain('Watch history: 1')
      expect(text).toContain('2 left out: required fields missing')
      expect(text).toContain('Settings: 1')
      expect(text).toContain('1 left out: a setting that belongs to the machine')
      expect(text).toContain('1 left out: a setting this version does not know')
      expect(text).not.toContain('Playlists')
      expect(text).toContain('Ignored, as this version does not know them: watchParties')
      expect(text).toContain(`Your data as it is now is saved first, in ${BACKUP_FOLDER}.`)
      expect(text).toContain('Fjernsyn restarts once the backup is restored.')
      expect(text).not.toContain('downloads are running')
    })

    it('says when the backup is from this installation, and on which machine', async () => {
      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }, { installationId: 'this-installation', machineName: MACHINE_NAME }))

      expect(confirmation().textContent).toContain(`Written by Fjernsyn 0.1.200 on ${MACHINE_NAME}, this installation.`)
    })

    it('says this installation alone for an older backup from here, which does not name the machine', async () => {
      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }, { installationId: 'this-installation', machineName: undefined }))

      expect(confirmation().textContent).toContain('Written by Fjernsyn 0.1.200 on this installation.')
    })

    it('says another machine for a backup from elsewhere that does not name one', async () => {
      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }, { machineName: undefined }))

      expect(confirmation().textContent).toContain('Written by Fjernsyn 0.1.200 on another machine.')
    })

    it('offers backups and gzipped backups in the picker', async () => {
      await chooseBackup(null)

      const [options] = window.showOpenFilePicker.mock.calls[0]
      expect(options.types).toEqual([{
        description: 'Fjernsyn backup',
        accept: { 'application/json': ['.json'], 'application/gzip': ['.gz'] },
      }])
    })

    it('reads a gzipped backup as it reads a plain one, by its first two bytes whatever its name', async () => {
      const text = backupFile({ profiles: [MAIN_PROFILE], history: [HISTORY] })
      const gzipped = gzipSync(strToU8(text))
      expect([...gzipped.subarray(0, 2)]).toEqual([0x1f, 0x8b])

      await chooseBackup(gzipped)

      const shown = confirmation().textContent
      expect(shown).toContain('Written by Fjernsyn 0.1.200 on synthetic-laptop.')
      expect(shown).toContain('Profiles and subscriptions: 1')
      expect(shown).toContain('Watch history: 1')

      confirmationButton('Restore').click()
      await flushPromises()

      const [request] = window.ftElectron.restoreBackup.mock.calls[0]
      expect(request.sections).toEqual({ profiles: [MAIN_PROFILE], history: [HISTORY] })
    })

    it('says it cannot read a file that begins as gzip and is not', async () => {
      await chooseBackup(new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02]))

      expect(confirmation()).toBeNull()
      expect(toasts()).toHaveLength(1)
      expect(toasts()[0]).toMatch(/^Unable to read file: /)
      expect(window.ftElectron.restoreBackup).not.toHaveBeenCalled()
    })

    it('names the downloads that are running, which the relaunch stops', async () => {
      vi.mocked(listAllDownloads).mockResolvedValue({
        downloads: [
          { videoId: 'a', title: 'Sprite Fright', status: 'downloading' },
          { videoId: 'b', title: 'Finished one', status: 'finished' },
          { videoId: 'c', title: 'Big Buck Bunny', status: 'merging' },
        ],
        finished: {},
      })

      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }))

      expect(confirmation().textContent).toContain('These downloads are running and stop when Fjernsyn restarts: Sprite Fright, Big Buck Bunny')
    })

    it('changes nothing on Cancel', async () => {
      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }))

      confirmationButton('Cancel').click()
      await flushPromises()

      expect(confirmation()).toBeNull()
      expect(window.ftElectron.restoreBackup).not.toHaveBeenCalled()
    })

    it('sends the safety copy, built as Export backup builds a backup, and the sections to replace on Restore', async () => {
      const exported = (await exportBackup()).content
      document.body.innerHTML = '<div class="app"></div>'

      await chooseBackup(backupFile({
        profiles: [MAIN_PROFILE],
        settings: [{ _id: 'maxVolume', value: 300 }, { _id: 'proxyHostname', value: '10.0.0.9' }],
      }))

      confirmationButton('Restore').click()
      await flushPromises()

      expect(confirmation()).toBeNull()
      expect(window.ftElectron.restoreBackup).toHaveBeenCalledTimes(1)
      const [request] = window.ftElectron.restoreBackup.mock.calls[0]
      expect(request.safetyCopy).toBe(exported)
      expect(JSON.parse(request.safetyCopy).machineName).toBe(MACHINE_NAME)
      expect(request.sections).toEqual({
        profiles: [MAIN_PROFILE],
        settings: [{ _id: 'maxVolume', value: 300 }],
      })
      expect(toasts().at(-1)).toBe('Restoring the backup. Fjernsyn restarts when it is done.')
    })

    it('shows a failure with where the safety copy is', async () => {
      const safetyCopyPath = `${BACKUP_FOLDER}/before-restore-2026-10-04-163005.json`
      window.ftElectron.restoreBackup.mockResolvedValue({ ok: false, error: 'disk full', safetyCopyPath })

      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }))
      confirmationButton('Restore').click()
      await flushPromises()

      expect(toasts()).toEqual([
        'Restoring the backup. Fjernsyn restarts when it is done.',
        `The restore failed: disk full. Some sections may already be replaced. Your data from before the restore is in ${safetyCopyPath}; restore that file to go back.`,
      ])
    })

    it('says nothing was changed when it failed before the safety copy was written', async () => {
      window.ftElectron.restoreBackup.mockResolvedValue({ ok: false, error: 'Could not write the safety copy: read-only', safetyCopyPath: null })

      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }))
      confirmationButton('Restore').click()
      await flushPromises()

      expect(toasts()).toEqual([
        'Restoring the backup. Fjernsyn restarts when it is done.',
        'The restore failed, and nothing was changed: Could not write the safety copy: read-only',
      ])
    })

    it('shows a failure when main cannot be reached', async () => {
      window.ftElectron.restoreBackup.mockRejectedValue(new Error('no handler'))

      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }))
      confirmationButton('Restore').click()
      await flushPromises()

      expect(toasts().at(-1)).toBe('The restore failed, and nothing was changed: Error: no handler')
    })
  })

  describe('the kept backup', () => {
    // 16:30 on 7 October 2026, local time
    const NOW = new Date(2026, 9, 7, 16, 30)
    const AT_1402 = new Date(2026, 9, 7, 14, 2).getTime()

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Main pushing a status, as it does on every change */
    async function push(status) {
      const [[handler]] = window.ftElectron.handleKeeperStatus.mock.calls
      handler(status)
      await flushPromises()
    }

    async function mountKeeping(status) {
      window.ftElectron.getKeeperStatus.mockResolvedValue(status)
      const wrapper = mountBackup()
      await flushPromises()
      return wrapper
    }

    const folderRow = wrapper => wrapper.findAll('.keeperRow')[0]

    /** The status line's text and its buttons, or null when there is none */
    function statusLine(wrapper) {
      const row = wrapper.findAll('.keeperRow')[1]
      return row === undefined
        ? null
        : { text: row.find('.keeperStatus').text(), buttons: row.findAll('button').map(found => found.text()) }
    }

    it('says Not set and offers Choose folder alone when nothing is kept', async () => {
      const wrapper = await mountKeeping(NOT_KEEPING)

      expect(folderRow(wrapper).text()).toContain('Keep a backup in')
      expect(folderRow(wrapper).text()).toContain('Not set')
      expect(folderRow(wrapper).findAll('button').map(found => found.text())).toEqual(['Choose folder'])
      expect(statusLine(wrapper)).toBeNull()
    })

    it('shows the folder chosen in main\'s dialog, and Stop keeping', async () => {
      window.ftElectron.chooseKeeperFolder.mockResolvedValue(keeping())
      const wrapper = await mountKeeping(NOT_KEEPING)

      await button(wrapper, 'Choose folder').trigger('click')
      await flushPromises()

      expect(window.ftElectron.chooseKeeperFolder).toHaveBeenCalledTimes(1)
      expect(folderRow(wrapper).text()).toContain(KEPT_FOLDER)
      expect(folderRow(wrapper).findAll('button').map(found => found.text())).toEqual(['Choose folder', 'Stop keeping'])
      expect(statusLine(wrapper)).toEqual({ text: 'Not written yet', buttons: [] })
    })

    it('goes back to Not set on Stop keeping', async () => {
      const wrapper = await mountKeeping(keeping({ writtenAt: AT_1402 }))

      await button(wrapper, 'Stop keeping').trigger('click')
      await flushPromises()

      expect(window.ftElectron.stopKeeping).toHaveBeenCalledTimes(1)
      expect(folderRow(wrapper).text()).toContain('Not set')
      expect(statusLine(wrapper)).toBeNull()
    })

    it('follows the status main pushes, with the date when the write was not today', async () => {
      const wrapper = await mountKeeping(keeping())

      await push(keeping({ writtenAt: AT_1402 }))
      expect(statusLine(wrapper)).toEqual({ text: 'Written 14:02', buttons: [] })

      await push(keeping({ writtenAt: new Date(2026, 9, 6, 9, 5).getTime() }))
      expect(statusLine(wrapper)).toEqual({ text: 'Written 2026-10-06 09:05', buttons: [] })
    })

    it('shows every state with its buttons', async () => {
      const pause = { key: 'k', machineName: 'synthetic-laptop', writtenAt: AT_1402, detail: null, formatVersion: null }
      const states = [
        [{ failure: { message: 'ENOSPC: no space left on device', since: AT_1402 } }, 'Couldn\'t write: ENOSPC: no space left on device', []],
        [{ pause: { ...pause, reason: 'otherMachine' } }, 'Paused: synthetic-laptop wrote the backup at 14:02.', ['Restore (relaunches)', 'Overwrite with this machine\'s data']],
        [{ pause: { ...pause, reason: 'otherMachine', machineName: null } }, 'Paused: another machine wrote the backup at 14:02.', ['Restore (relaunches)', 'Overwrite with this machine\'s data']],
        [{ pause: { ...pause, reason: 'refused', detail: 'baseMismatch' } }, 'Paused: the backup in the folder can\'t be read (its base file does not match it).', ['Overwrite with this machine\'s data']],
        [{ pause: { ...pause, reason: 'refused' } }, 'Paused: the backup in the folder can\'t be read.', ['Overwrite with this machine\'s data']],
        [{ pause: { ...pause, reason: 'newer', formatVersion: 2 } }, 'Paused: the backup was written by a newer Fjernsyn. Update Fjernsyn to keep it.', []],
        [{ pause: { ...pause, reason: 'baseMissing' } }, 'Paused: the backup synthetic-laptop wrote at 14:02 is still arriving.', []],
      ]

      const wrapper = await mountKeeping(keeping())

      for (const [fields, text, buttons] of states) {
        await push(keeping({ writtenAt: AT_1402, ...fields }))
        expect(statusLine(wrapper)).toEqual({ text, buttons })
      }
    })

    it('sends the answer a pause\'s button gives', async () => {
      const pause = { reason: 'otherMachine', key: 'k', machineName: 'synthetic-laptop', writtenAt: AT_1402, detail: null, formatVersion: null }
      const wrapper = await mountKeeping(keeping({ pause }))
      window.ftElectron.answerKeeper.mockResolvedValue(keeping({ pause }))

      await button(wrapper, 'Restore (relaunches)').trigger('click')
      await button(wrapper, 'Overwrite with this machine\'s data').trigger('click')
      await flushPromises()

      expect(window.ftElectron.answerKeeper.mock.calls).toEqual([['restore'], ['overwrite']])
    })
  })
})
