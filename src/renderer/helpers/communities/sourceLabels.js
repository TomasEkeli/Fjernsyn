/**
 * How a followed source is described where it is listed (the Sources page)
 * and on its own page: what kind of place it is, and the instance it is on.
 */

/** @import { Source } from './shares.js' */

/**
 * What kind of place a source is, in words; its `kind` as it is for a kind
 * this version has no words for
 *
 * @param {string} kind
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function sourceKindLabel(kind, t) {
  switch (kind) {
    case 'hackertube':
      return t('Sources.Kinds.HackerTube')
    case 'lemmy':
      return t('Sources.Kinds.Lemmy')
    default:
      return kind
  }
}

/**
 * The instance a source is on: its URL's host, and its port if it has one;
 * empty for a URL that cannot be read
 *
 * @param {Pick<Source, 'url'>} source
 * @returns {string}
 */
export function sourceInstance({ url }) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
