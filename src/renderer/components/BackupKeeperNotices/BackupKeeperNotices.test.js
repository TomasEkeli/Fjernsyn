import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { showToast } from '../../helpers/utils'
import { mountWithApp } from '../../testing/mount'
import BackupKeeperNotices from './BackupKeeperNotices.vue'

// The keeper's notices, with main stubbed: what each prompt says and the
// answer it sends, the wait over the start screen, and the toasts, each once

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
const KEEPING = { folder: '/home/me/Sync/fjernsyn', ready: true, writtenAt: AT_1402, failure: null, pause: null, arriving: null, tookIn: null }

const pause = (fields) => ({ key: 'pause-1', machineName: 'synthetic-laptop', writtenAt: AT_1402, detail: null, formatVersion: null, ...fields })

let wrapper = null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  sessionStorage.clear()
  vi.mocked(showToast).mockClear()
  document.body.innerHTML = '<div id="root"></div>'

  window.ftElectron = {
    isMainWindow: vi.fn(async () => true),
    handleMainWindowChanged: vi.fn(),
    getKeeperStatus: vi.fn(async () => KEEPING),
    handleKeeperStatus: vi.fn(),
    answerKeeper: vi.fn(async () => KEEPING),
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

async function choose(label) {
  const found = [...document.querySelectorAll('.prompt button')].find(button => button.textContent.trim() === label)
  if (!found) {
    throw new Error(`no button "${label}"`)
  }
  found.click()
  await flushPromises()
}

async function closePrompt() {
  document.querySelector('.prompt').click()
  await flushPromises()
}

const answers = () => window.ftElectron.answerKeeper.mock.calls.map(([answer]) => answer)
const toasts = () => vi.mocked(showToast).mock.calls.map(([message]) => message)

describe('the startup question about a base still arriving', () => {
  const ARRIVING = { ...KEEPING, ready: false, arriving: { machineName: 'synthetic-laptop', writtenAt: AT_1402, waitingSince: null } }

  it('asks over the start screen, before the page is there', async () => {
    await mountNotices(ARRIVING, { windowUp: false })

    expect(document.querySelector('.page')).toBeNull()
    expect(shownPrompt()).toEqual({
      text: 'The backup synthetic-laptop wrote at 14:02 is still arriving: its base file is not in the folder yet.',
      buttons: ['Wait for it', 'Continue with this machine\'s data'],
    })
  })

  it('sends the choice, and is not answered by closing it', async () => {
    for (const [label, answer] of [['Wait for it', 'wait'], ['Continue with this machine\'s data', 'continue']]) {
      window.ftElectron.answerKeeper.mockClear()
      await mountNotices(ARRIVING, { windowUp: false })

      await closePrompt()
      expect(answers()).toEqual([])
      expect(shownPrompt()).not.toBeNull()

      await choose(label)
      expect(answers()).toEqual([answer])
      wrapper.unmount()
      wrapper = null
    }
  })

  it('shows the time waited, ticking each second, and sends Stop waiting', async () => {
    const waiting = { ...ARRIVING, arriving: { ...ARRIVING.arriving, waitingSince: NOW.getTime() - 65_000 } }
    await mountNotices(waiting, { windowUp: false })

    expect(shownPrompt()).toBeNull()
    expect(wrapper.find('.keeperWaiting p').text()).toBe('Waiting for the base file: 1:05')

    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(wrapper.find('.keeperWaiting p').text()).toBe('Waiting for the base file: 1:06')

    await wrapper.find('.keeperWaiting button').trigger('click')
    await flushPromises()
    expect(answers()).toEqual(['stopWaiting'])
  })
})

describe('a pause', () => {
  it('asks Restore, Overwrite or Not now when another machine wrote the backup, once the page is up', async () => {
    const status = { ...KEEPING, pause: pause({ reason: 'otherMachine' }) }
    await mountNotices(status, { windowUp: false })

    expect(shownPrompt()).toBeNull()

    showPage()
    await wrapper.setProps({ windowUp: true })
    await flushPromises()

    expect(shownPrompt()).toEqual({
      text: 'synthetic-laptop wrote the backup at 14:02. Restore it (relaunches) or overwrite it with this machine\'s data?',
      buttons: ['Restore', 'Overwrite', 'Not now'],
    })
  })

  it('sends each answer', async () => {
    const choices = [['Restore', 'restore'], ['Overwrite', 'overwrite'], ['Not now', 'notNow']]

    for (const [index, [label, answer]] of choices.entries()) {
      await mountNotices({ ...KEEPING, pause: pause({ reason: 'otherMachine', key: `pause-${index}` }) }, { windowUp: true })

      await choose(label)

      expect(answers().at(-1)).toBe(answer)
      expect(shownPrompt()).toBeNull()
      wrapper.unmount()
      wrapper = null
    }
  })

  it('takes closing the prompt as Not now', async () => {
    await mountNotices({ ...KEEPING, pause: pause({ reason: 'otherMachine', machineName: null }) }, { windowUp: true })

    expect(shownPrompt().text).toBe('another machine wrote the backup at 14:02. Restore it (relaunches) or overwrite it with this machine\'s data?')

    await closePrompt()

    expect(answers()).toEqual(['notNow'])
    expect(shownPrompt()).toBeNull()
  })

  it('asks once per pause, a reload of the window included', async () => {
    const status = { ...KEEPING, pause: pause({ reason: 'otherMachine' }) }
    await mountNotices(status, { windowUp: true })
    await choose('Not now')

    await push({ ...status })
    expect(shownPrompt()).toBeNull()

    wrapper.unmount()
    await mountNotices(status, { windowUp: true })
    expect(shownPrompt()).toBeNull()

    await push({ ...KEEPING, pause: pause({ reason: 'otherMachine', key: 'pause-2' }) })
    expect(shownPrompt()).not.toBeNull()
  })

  it('offers Overwrite or Not now for a backup that cannot be read', async () => {
    await mountNotices({ ...KEEPING, pause: pause({ reason: 'refused', detail: 'notJson' }) }, { windowUp: true })

    expect(shownPrompt()).toEqual({
      text: 'The backup in the folder can\'t be read (it is not JSON). Overwrite it with this machine\'s data?',
      buttons: ['Overwrite with this machine\'s data', 'Not now'],
    })

    await choose('Overwrite with this machine\'s data')
    expect(answers()).toEqual(['overwrite'])
  })

  it('offers only Not now for a backup from a newer Fjernsyn', async () => {
    await mountNotices({ ...KEEPING, pause: pause({ reason: 'newer', formatVersion: 2 }) }, { windowUp: true })

    expect(shownPrompt()).toEqual({
      text: 'The backup in the folder was written by a newer Fjernsyn, which this version can\'t read. Update Fjernsyn to keep it.',
      buttons: ['Not now'],
    })
  })

  it('does not ask while the base is still arriving after Continue', async () => {
    await mountNotices({ ...KEEPING, pause: pause({ reason: 'baseMissing' }) }, { windowUp: true })

    expect(shownPrompt()).toBeNull()
  })

  it('asks nothing in a window that is not the main one', async () => {
    window.ftElectron.isMainWindow.mockResolvedValue(false)
    await mountNotices({ ...KEEPING, pause: pause({ reason: 'otherMachine' }) }, { windowUp: true })

    expect(shownPrompt()).toBeNull()
  })
})

describe('the toasts', () => {
  it('tells of a take in once, when the page is up', async () => {
    const status = { ...KEEPING, tookIn: { key: 'took-1', machineName: 'synthetic-laptop', writtenAt: AT_1402 } }
    await mountNotices(status, { windowUp: false })

    expect(toasts()).toEqual([])

    showPage()
    await wrapper.setProps({ windowUp: true })
    await flushPromises()
    expect(toasts()).toEqual(['Restored from the backup written by synthetic-laptop at 14:02'])

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
