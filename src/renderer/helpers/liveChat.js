import autolinker from 'autolinker'
import { YTNodes } from 'youtubei.js'

import { parseLocalTextRuns } from './api/local'

/** How long the chat over the video stays up with nothing said in it before it fades */
export const OVERLAY_QUIET_AFTER_MS = 60_000

/**
 * A live chat message as the player's chat overlay shows it: who wrote it, in
 * which role, what they wrote (as HTML, emojis and links included, for
 * `v-safer-html`) and when. A Super Chat carries its amount.
 *
 * @typedef {object} OverlayChatMessage
 * @property {string} id
 * @property {{ name: string, isOwner: boolean, isModerator: boolean, isMember: boolean }} author
 * @property {string} message
 * @property {number} timestamp when it was written, in milliseconds since the epoch, `NaN` where unknown
 * @property {string | null} amount a Super Chat's amount, `null` for an ordinary message
 */

/**
 * The time of day a chat message was written, as the clock on the wall reads
 * it in the viewer's locale (`14:05`, `2:05 PM`), or `''` where the time is
 * not known.
 *
 * @param {number} timestamp milliseconds since the epoch
 * @param {string[]} locales
 * @returns {string}
 */
export function formatChatTime(timestamp, locales) {
  if (!Number.isFinite(timestamp)) {
    return ''
  }

  return new Intl.DateTimeFormat(locales, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
}

/**
 * The same time as an ISO string, for a `<time>` element's `datetime`
 *
 * @param {number} timestamp milliseconds since the epoch
 * @returns {string | undefined}
 */
export function chatTimeAttribute(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

/**
 * An item the chat added, as the overlay shows it, or `null` for an item it
 * does not show (memberships, stickers, placeholders and the like, which the
 * side panel leaves out too).
 *
 * @param {import('youtubei.js').YTNodes.LiveChatTextMessage | import('youtubei.js').YTNodes.LiveChatPaidMessage | any} item
 * @param {string} channelId the channel streaming, whose messages are the owner's
 * @returns {OverlayChatMessage | null}
 */
export function parseOverlayChatItem(item, channelId) {
  const isText = item.is(YTNodes.LiveChatTextMessage)

  if (!isText && !item.is(YTNodes.LiveChatPaidMessage)) {
    return null
  }

  const { author } = item
  const runs = item.message?.runs

  return {
    id: item.id,
    author: {
      name: chatAuthorName(author),
      isOwner: author.id === channelId,
      isModerator: !!author.is_moderator,
      isMember: (author.badges ?? []).some(badge => badge.is(YTNodes.LiveChatAuthorBadge) && badge.custom_thumbnail),
    },
    message: Array.isArray(runs) ? autolinker.link(parseLocalTextRuns(runs, 20)) : '',
    timestamp: item.timestamp,
    amount: isText ? null : item.purchase_amount,
  }
}

/**
 * A chat author's name. youtubei.js's `Author` holds it as a string; the side
 * panel reads a Super Chat's as a `Text` (`.text`), which it is not, so both
 * are taken here.
 *
 * @param {{ name: string | { text?: string } }} author
 * @returns {string}
 */
export function chatAuthorName(author) {
  const { name } = author
  return typeof name === 'string' ? name : (name?.text ?? '')
}
