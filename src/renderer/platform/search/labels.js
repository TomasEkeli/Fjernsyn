// The words for the search query's values, through the app's translation
// function, which callers hand in (the layer knows no i18n). One function per
// parameter with every key written out, so the locale checks can see them.

/**
 * @typedef {(key: string, values?: Record<string, unknown>) => string} Translate
 */

/**
 * @param {Translate} t
 * @param {string} scope
 */
export function scopeLabel(t, scope) {
  switch (scope) {
    case 'peertube': return t('Layer Search.Scope.peertube')
    case 'all': return t('Layer Search.Scope.all')
    default: return t('Layer Search.Scope.youtube')
  }
}

/**
 * The name of a platform, for "Not applied to YouTube" and the like.
 *
 * @param {Translate} t
 * @param {string} platform
 */
export function platformName(t, platform) {
  return platform === 'peertube' ? t('Layer Search.Scope.peertube') : t('Layer Search.Scope.youtube')
}

/**
 * @param {Translate} t
 * @param {string} platform
 */
export function sectionHeading(t, platform) {
  return platform === 'peertube' ? t('Layer Search.From.peertube') : t('Layer Search.From.youtube')
}

/**
 * @param {Translate} t
 * @param {string | null} sort
 */
export function sortLabel(t, sort) {
  switch (sort) {
    case 'date': return t('Layer Search.Values.Sort.date')
    case 'views': return t('Layer Search.Values.Sort.views')
    case 'trending': return t('Layer Search.Values.Sort.trending')
    default: return t('Layer Search.Values.Sort.relevance')
  }
}

/**
 * @param {Translate} t
 * @param {string | null} time
 */
export function timeLabel(t, time) {
  switch (time) {
    case 'today': return t('Layer Search.Values.Time.today')
    case 'week': return t('Layer Search.Values.Time.week')
    case 'month': return t('Layer Search.Values.Time.month')
    case 'year': return t('Layer Search.Values.Time.year')
    default: return t('Layer Search.Chips.Time')
  }
}

/**
 * @param {Translate} t
 * @param {string | null} type
 */
export function typeLabel(t, type) {
  switch (type) {
    case 'all': return t('Layer Search.Values.Type.all')
    case 'channel': return t('Layer Search.Values.Type.channel')
    case 'playlist': return t('Layer Search.Values.Type.playlist')
    case 'shorts': return t('Layer Search.Values.Type.shorts')
    case 'movie': return t('Layer Search.Values.Type.movie')
    default: return t('Layer Search.Values.Type.video')
  }
}

/**
 * @param {Translate} t
 * @param {string | null} length
 */
export function lengthLabel(t, length) {
  switch (length) {
    case 'short': return t('Layer Search.Values.Length.short')
    case 'medium': return t('Layer Search.Values.Length.medium')
    case 'long': return t('Layer Search.Values.Length.long')
    default: return t('Layer Search.Chips.Length')
  }
}

/**
 * @param {Translate} t
 * @param {boolean | null} nsfw
 */
export function nsfwLabel(t, nsfw) {
  if (nsfw === true) {
    return t('Layer Search.Values.NSFW.shown')
  }

  return nsfw === false ? t('Layer Search.Values.NSFW.hidden') : t('Layer Search.Chips.NSFW default')
}

// The lower case words `describe` joins

/**
 * @param {Translate} t
 * @param {string} scope
 */
export function scopeWord(t, scope) {
  switch (scope) {
    case 'peertube': return t('Layer Search.Words.Scope.peertube')
    case 'all': return t('Layer Search.Words.Scope.all')
    default: return t('Layer Search.Words.Scope.youtube')
  }
}

/**
 * @param {Translate} t
 * @param {string} sort
 */
export function sortWord(t, sort) {
  switch (sort) {
    case 'date': return t('Layer Search.Words.Sort.date')
    case 'views': return t('Layer Search.Words.Sort.views')
    default: return t('Layer Search.Words.Sort.trending')
  }
}

/**
 * @param {Translate} t
 * @param {string} time
 */
export function timeWord(t, time) {
  switch (time) {
    case 'today': return t('Layer Search.Words.Time.today')
    case 'week': return t('Layer Search.Words.Time.week')
    case 'month': return t('Layer Search.Words.Time.month')
    default: return t('Layer Search.Words.Time.year')
  }
}

/**
 * @param {Translate} t
 * @param {string} type
 */
export function typeWord(t, type) {
  switch (type) {
    case 'all': return t('Layer Search.Words.Type.all')
    case 'channel': return t('Layer Search.Words.Type.channel')
    case 'playlist': return t('Layer Search.Words.Type.playlist')
    case 'shorts': return t('Layer Search.Words.Type.shorts')
    default: return t('Layer Search.Words.Type.movie')
  }
}

/**
 * @param {Translate} t
 * @param {string} length
 */
export function lengthWord(t, length) {
  switch (length) {
    case 'short': return t('Layer Search.Words.Length.short')
    case 'medium': return t('Layer Search.Words.Length.medium')
    default: return t('Layer Search.Words.Length.long')
  }
}

/**
 * @param {Translate} t
 * @param {boolean} nsfw
 */
export function nsfwWord(t, nsfw) {
  return nsfw ? t('Layer Search.Words.NSFW shown') : t('Layer Search.Words.NSFW hidden')
}
