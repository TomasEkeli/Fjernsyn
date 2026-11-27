import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { showToast } from '../../helpers/utils'
import { mountWithApp } from '../../testing/mount'
import BackupKeeperNotices from './BackupKeeperNotices.vue'

// The keeper's notices, with main stubbed: the toasts, each told once, and
// the load of what the keeper changed in every window (its own tests are
// useKeeperRefresh's)

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return { default: createFakeStore() }
})

vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

vi.mock('../../helpers/utils', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn(),
}))

// 16:30 on 7 October 2026, local time
const NOW = new Date(2026, 9, 7, 16, 30)
const AT_1402 = new Date(2026, 9, 7, 14, 2).getTime()

/** @type {import('../../../main/backup/keeper').KeeperStatus} */
const KEEPING = { folder: '/home/me/Sync/fjernsyn', ready: true, writtenAt: AT_1402, failure: null, mergedFrom: null }

const pause = (fields) => ({ key: 'pause-1', machineName: 'synthetic-laptop', writtenAt: AT_1402, detail: null, formatVersion: null, ...fields })

let wrapper = null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  sessionStorage.clear()
  vi.mocked(showToast).mockClear()
  document.body.innerHTML = '<div id="root"></div>'

  window.ftElectron = {
    isMainWindow: vi.fn(async () => true),
    handleMainWindowChanged: vi.fn(),
    getKeeperStatus: vi.fn(async () => KEEPING),
    handleKeeperStatus: vi.fn(),
    handleKeeperDataChanged: vi.fn(),
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  delete window.ftElectron
})

/**
 * Mounts the notices with main giving this status, over the start screen or
 * over the page, as a window loading afresh: a new bridge, with the same
 * stubs, and what sessionStorage holds. The page's `.app` is there only once
 * the window is up, as in App.
 */
async function mountNotices(status, { windowUp }) {
  if (windowUp) {
    showPage()
  }

  window.ftElectron = { ...window.ftElectron }
  window.ftElectron.getKeeperStatus.mockResolvedValue(status)
  wrapper = mountWithApp(BackupKeeperNotices, { props: { windowUp }, attachTo: '#root' })
  await flushPromises()
}

function showPage() {
  document.body.insertAdjacentHTML('afterbegin', '<div class="app page"></div>')
}

/** Main pushing a status, as it does on every change */
async function push(status) {
  const [[handler]] = window.ftElectron.handleKeeperStatus.mock.calls.slice(-1)
  handler(status)
  await flushPromises()
}

function shownPrompt() {
  const found = document.querySelector('.prompt')
  return found === null
    ? null
    : { text: found.querySelector('h2').textContent.trim(), buttons: [...found.querySelectorAll('button')].map(button => button.textContent.trim()) }
}

const toasts = () => vi.mocked(showToast).mock.calls.map(([message]) => message)

describe('another machine\'s changes', () => {
  it('offers no restore or overwrite prompt, as there is nothing left to answer', async () => {
    // The pause and the base awaited are what the prompts asked about, and
    // both went with the lock. A status still naming one asks nothing.
    const stale = { ...KEEPING, pause: pause({ reason: 'refused', detail: 'notJson' }), arriving: { machineName: 'synthetic-laptop', writtenAt: AT_1402, since: AT_1402 } }

    // With the page up from the start, so that a prompt would have its hold
    // to teleport into: one mounted over the start screen goes nowhere and
    // would look the same as none at all
    await mountNotices(stale, { windowUp: true })

    expect(shownPrompt()).toBeNull()
    expect(document.querySelector('.app').textContent.trim()).toBe('')

    await push(stale)
    expect(shownPrompt()).toBeNull()
  })

  it('are loaded again in a window that is not the main one, once its data is', async () => {
    window.ftElectron.isMainWindow.mockResolvedValue(false)
    store.dispatched.length = 0
    await mountNotices(KEEPING, { windowUp: true })

    const [[handler]] = window.ftElectron.handleKeeperDataChanged.mock.calls
    handler({ sections: ['history'], history: null })
    await flushPromises()

    expect(store.dispatched.map(({ type }) => type)).toEqual(['grabHistory'])
  })
})

describe('the toasts', () => {
  it('waits for the page, and tells the same run no second time after a reload', async () => {
    const status = { ...KEEPING, failure: { message: 'EACCES: permission denied', since: AT_1402 } }
    await mountNotices(status, { windowUp: false })

    expect(toasts()).toEqual([])

    showPage()
    await wrapper.setProps({ windowUp: true })
    await flushPromises()
    expect(toasts()).toEqual(['Couldn\'t write the kept backup: EACCES: permission denied'])

    await push({ ...status })
    wrapper.unmount()
    await mountNotices(status, { windowUp: true })
    expect(toasts()).toHaveLength(1)
  })

  it('tells of failed writes once for each run of them', async () => {
    await mountNotices({ ...KEEPING, failure: { message: 'EACCES: permission denied', since: AT_1402 } }, { windowUp: true })
    await push({ ...KEEPING, failure: { message: 'ENOENT: no such file or directory', since: AT_1402 } })
    await push(KEEPING)
    await push({ ...KEEPING, failure: { message: 'ENOSPC: no space left on device', since: AT_1402 + 300_000 } })

    expect(toasts()).toEqual([
      'Couldn\'t write the kept backup: EACCES: permission denied',
      'Couldn\'t write the kept backup: ENOSPC: no space left on device',
    ])
  })
})
