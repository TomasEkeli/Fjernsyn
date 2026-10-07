import { shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The kept backup's status as main's keeper last gave it, shared by the Backup
 * group and the notices, and the calls that change it. Main pushes the status
 * to every window on every change, and each call answers with the status it
 * left, so what a window shows is never older than its last call.
 */

/** @type {import('vue').ShallowRef<import('../../main/backup/keeper').KeeperStatus | null>} */
const status = shallowRef(null)

/**
 * The bridge the listener is registered on. The preload gives no way to remove
 * a listener, so a window registers one and every component showing the
 * status shares it. Kept as the bridge rather than a flag, as a test replaces
 * the bridge along with its stubs.
 */
let listeningTo = null

/** Whether a status has come from main since the listener was registered */
let heard = false

/**
 * @param {import('../../main/backup/keeper').KeeperStatus | null | undefined} next
 */
function apply(next) {
  if (next != null) {
    heard = true
    status.value = next
  }
}

/**
 * The keeper's status, null until main has given it. Always null outside
 * Electron, which has no keeper.
 * @returns {import('vue').ShallowRef<import('../../main/backup/keeper').KeeperStatus | null>}
 */
export function useKeeperStatus() {
  if (process.env.IS_ELECTRON && listeningTo !== window.ftElectron) {
    listeningTo = window.ftElectron
    status.value = null
    heard = false

    window.ftElectron.handleKeeperStatus(apply)

    window.ftElectron.getKeeperStatus().then(
      (current) => {
        // A push that came first is the newer
        if (!heard) {
          apply(current)
        }
      },
      (error) => console.error('Could not get the backup keeper\'s status', error)
    )
  }

  return status
}

/**
 * Sends a call to the keeper and takes the status it answers with. A failure
 * is logged: the status stays as it was, which is what the window shows.
 * @param {string} name
 * @param {() => Promise<import('../../main/backup/keeper').KeeperStatus>} call
 */
async function callKeeper(name, call) {
  try {
    apply(await call())
  } catch (error) {
    console.error(`The backup keeper did not take ${name}`, error)
  }
}

/**
 * @param {import('../../main/backup/keeper').KeeperAnswer} answer
 */
export function answerKeeper(answer) {
  return callKeeper(`the answer ${answer}`, () => window.ftElectron.answerKeeper(answer))
}

/** Main's folder dialog; a cancelled one leaves the status as it is */
export function chooseKeeperFolder() {
  return callKeeper('a folder', () => window.ftElectron.chooseKeeperFolder())
}

export function stopKeeping() {
  return callKeeper('Stop keeping', () => window.ftElectron.stopKeeping())
}

/** @param {number} value */
const twoDigits = value => String(value).padStart(2, '0')

/**
 * A time the keeper gives, as the local clock reads it, with the date in
 * front when it is not today: "14:02", "2026-10-06 14:02"
 * @param {number} ms
 * @param {number} [now]
 */
export function keeperTimeText(ms, now = Date.now()) {
  const time = new Date(ms)
  const today = new Date(now)
  const clock = `${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`

  if (time.toDateString() === today.toDateString()) {
    return clock
  }

  return `${time.getFullYear()}-${twoDigits(time.getMonth() + 1)}-${twoDigits(time.getDate())} ${clock}`
}

/**
 * The words the Backup group and the notices share about what the keeper
 * says: who wrote the file, when, and why it was refused
 */
export function useKeeperWords() {
  const { t } = useI18n()

  return {
    /** @param {string | null} name */
    machine: name => name ?? t('Settings.Data Settings.Backup.Keeper.Another machine'),

    /** @param {number | null} ms */
    time: ms => ms === null ? t('Settings.Data Settings.Backup.Keeper.Unknown time') : keeperTimeText(ms),

    /**
     * @param {string | null} detail
     * @returns {string | null} null for a reason this version does not know
     */
    refusedReason: (detail) => {
      switch (detail) {
        case 'notJson':
          return t('Settings.Data Settings.Backup.Keeper.Refused reasons.Not JSON')
        case 'notSyncFile':
          return t('Settings.Data Settings.Backup.Keeper.Refused reasons.Not a sync file')
        case 'malformedChanges':
          return t('Settings.Data Settings.Backup.Keeper.Refused reasons.Malformed changes')
        case 'baseMismatch':
          return t('Settings.Data Settings.Backup.Keeper.Refused reasons.Base mismatch')
        case 'baseUnreadable':
          return t('Settings.Data Settings.Backup.Keeper.Refused reasons.Base unreadable')
        default:
          return null
      }
    },
  }
}
