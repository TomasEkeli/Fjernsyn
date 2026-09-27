/**
 * An instance-supplied description as plain text, safe to store in a history
 * entry or playlist item.
 *
 * The old path's list card renders a stored record's `description` through
 * the strict `v-safer-html`, which still allows `<a href>` and
 * `<img src style>`, so HTML in what is stored would come alive there. The
 * tags are dropped (parsed in an inert document: nothing loads or runs), and
 * what is left is escaped, so the card shows it as the text it is.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function toStoredPlainText(text) {
  if (typeof text !== 'string' || text === '') {
    return ''
  }

  const stripped = new DOMParser().parseFromString(text, 'text/html').body.textContent ?? ''

  return stripped
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
