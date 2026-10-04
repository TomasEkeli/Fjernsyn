import { flushPromises } from '@vue/test-utils'
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
import { readFileWithPicker, showToast, writeFileWithPicker } from '../../helpers/utils'
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
  readFileWithPicker: vi.fn(),
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

/**
 * @param {Record<string, any>} sections
 * @param {Record<string, any>} [header]
 */
function backupFile(sections, header = {}) {
  return {
    filename: 'fjernsyn-backup-2026-10-01.json',
    content: JSON.stringify({ format: 'fjernsyn-backup', formatVersion: 1, appVersion: '0.1.200', installationId: 'other-installation', ...header, sections }),
  }
}

beforeEach(() => {
  document.body.innerHTML = '<div class="app"></div>'
  vi.mocked(showToast).mockClear()
  vi.mocked(writeFileWithPicker).mockClear()
  vi.mocked(readFileWithPicker).mockReset()
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
    restoreBackup: vi.fn(async () => ({ ok: true, safetyCopyPath: `${BACKUP_FOLDER}/before-restore-2026-10-04-163005.json` })),
  }
})

afterEach(() => {
  delete window.ftElectron
})

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
  vi.mocked(readFileWithPicker).mockResolvedValue(file)
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

    it('says nothing when the save is cancelled', async () => {
      vi.mocked(writeFileWithPicker).mockResolvedValueOnce(false)

      await exportBackup()

      expect(toasts()).toEqual([])
    })
  })

  describe('Restore backup', () => {
    it('shows a refusal with its reason, and sends nothing', async () => {
      const refusals = [
        [{ filename: 'x.json', content: 'not json' }, 'This file is not a backup: it is not JSON'],
        [{ filename: 'x.json', content: '{"_id":"maxVolume","value":1}' }, 'This file is not a Fjernsyn backup'],
        [backupFile({}, { formatVersion: 7 }), 'This backup was written by a newer version of Fjernsyn (backup format 7), which this version cannot read'],
        [backupFile({ profiles: {} }), 'This backup cannot be read: its section "profiles" is not a list'],
        [backupFile({ bookmarks: [] }), 'This backup holds nothing this version of Fjernsyn can restore'],
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
      expect(text).toContain('Written by Fjernsyn 0.1.200 on another installation.')
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

    it('says when the backup is from this installation', async () => {
      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }, { installationId: 'this-installation' }))

      expect(confirmation().textContent).toContain('Written by Fjernsyn 0.1.200 on this installation.')
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
      expect(request.sections).toEqual({
        profiles: [MAIN_PROFILE],
        settings: [{ _id: 'maxVolume', value: 300 }],
      })
      expect(toasts().filter(message => message.includes('failed'))).toEqual([])
    })

    it('shows a failure with where the safety copy is', async () => {
      const safetyCopyPath = `${BACKUP_FOLDER}/before-restore-2026-10-04-163005.json`
      window.ftElectron.restoreBackup.mockResolvedValue({ ok: false, error: 'disk full', safetyCopyPath })

      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }))
      confirmationButton('Restore').click()
      await flushPromises()

      expect(toasts()).toEqual([
        `The restore failed: disk full. Some sections may already be replaced. Your data from before the restore is in ${safetyCopyPath}; restore that file to go back.`,
      ])
    })

    it('says nothing was changed when it failed before the safety copy was written', async () => {
      window.ftElectron.restoreBackup.mockResolvedValue({ ok: false, error: 'Could not write the safety copy: read-only', safetyCopyPath: null })

      await chooseBackup(backupFile({ profiles: [MAIN_PROFILE] }))
      confirmationButton('Restore').click()
      await flushPromises()

      expect(toasts()).toEqual(['The restore failed, and nothing was changed: Could not write the safety copy: read-only'])
    })
  })
})
