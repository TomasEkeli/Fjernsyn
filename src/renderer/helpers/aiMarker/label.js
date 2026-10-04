/**
 * YouTube's AI label, read from a raw `/next` response.
 *
 * A creator who declares that a video was made with AI gets a "How this was
 * made" section in the video's structured description, saying "Made with AI"
 * and linking to YouTube's help answer about altered or synthetic content. The
 * same section, linking to another answer, says "Auto-dubbed" for a
 * human-made video whose other audio tracks were machine-translated, which is
 * not what anyone means by an AI video.
 *
 * The answer id is what is read, never the words: the header is in the
 * interface language ("Made with AI", "Laget med AI", "Mit KI erstellt"), and
 * so is the link's `hl` parameter, while the answer id is the same in every
 * one. The "AI" badge under the title is not read either. It agrees with the
 * section on every sample, and it is only words.
 *
 * Raw JSON rather than youtubei.js's parsed `VideoInfo`, so that a lookup
 * whose only question is this one does not pay for parsing a whole watch
 * page. The WEB, MWEB and TV clients' `/next`, and the watch page's embedded
 * `ytInitialData`, all carry the section; where in the panel it sits is not
 * relied on, only that it is in the engagement panels.
 *
 * Pure, so that the watch view and the lookup read it the same way.
 */

/** The verdict for a video YouTube labels "Made with AI" */
export const VERDICT_AI = 'ai'

/** The verdict for everything else, an auto-dubbed video and a video with no section included */
export const VERDICT_NOT_AI = 'not-ai'

/** YouTube's help answer on altered or synthetic content, which "Made with AI" links to */
export const AI_HELP_ANSWER = '15447836'

/** YouTube's help answer on auto-dubbing, which "Auto-dubbed" links to. Named so the difference is visible. */
export const AUTO_DUBBED_HELP_ANSWER = '15569972'

const SECTION_KEY = 'howThisWasMadeSectionViewModel'

const AI_ANSWER_LINK = new RegExp(`/answer/${AI_HELP_ANSWER}(?!\\d)`)

/**
 * How deep under `engagementPanels` the section is looked for. It sits five
 * levels down today; the margin is for a client that nests it differently,
 * and the limit for a response that is not what it should be.
 */
const MAX_DEPTH = 12

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {(section: object) => boolean} test
 * @returns {boolean} whether any "How this was made" section passes
 */
function anySection(value, depth, test) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') { return false }

  if (Array.isArray(value)) {
    return value.some(item => anySection(item, depth + 1, test))
  }

  for (const [key, inner] of Object.entries(value)) {
    if (key === SECTION_KEY && inner !== null && typeof inner === 'object' && test(inner)) { return true }
    if (anySection(inner, depth + 1, test)) { return true }
  }

  return false
}

/**
 * @param {unknown} value
 * @returns {boolean} whether a string anywhere in it links to the AI help answer
 */
function linksToAiAnswer(value) {
  if (typeof value === 'string') { return AI_ANSWER_LINK.test(value) }
  if (value === null || typeof value !== 'object') { return false }

  return Object.values(value).some(linksToAiAnswer)
}

/**
 * The verdict for a video, from its `/next` response.
 *
 * @param {any} nextResponse the raw `/next` JSON, any client
 * @returns {'ai' | 'not-ai'}
 */
export function readAiLabel(nextResponse) {
  const panels = nextResponse?.engagementPanels

  if (!Array.isArray(panels)) { return VERDICT_NOT_AI }

  return anySection(panels, 0, section => linksToAiAnswer(section.bodyText ?? section))
    ? VERDICT_AI
    : VERDICT_NOT_AI
}
