import { describe, expect, it } from 'vitest'

import madeWithAi from './fixtures/local--next-made-with-ai.json'
import madeWithAiMweb from './fixtures/local--next-made-with-ai-mweb.json'
import madeWithAiMwebNorwegian from './fixtures/local--next-made-with-ai-mweb-nb.json'
import autoDubbed from './fixtures/local--next-auto-dubbed.json'
import ordinary from './fixtures/local--next-ordinary.json'
import { readAiLabel } from './label'

describe('readAiLabel', () => {
  it('reads a video labelled "Made with AI" as ai', () => {
    expect(readAiLabel(madeWithAi.answer)).toBe('ai')
  })

  it('reads the MWEB client\'s answer for it the same', () => {
    expect(readAiLabel(madeWithAiMweb.answer)).toBe('ai')
  })

  it('reads the label by its help answer, not its words, so another language reads the same', () => {
    const section = JSON.stringify(madeWithAiMwebNorwegian.answer)
    expect(section).toContain('Laget med AI')
    expect(section).not.toContain('Made with AI')

    expect(readAiLabel(madeWithAiMwebNorwegian.answer)).toBe('ai')
  })

  it('reads an auto-dubbed video as not-ai: it is human-made, with machine-translated audio', () => {
    expect(readAiLabel(autoDubbed.answer)).toBe('not-ai')
  })

  it('reads a video with no "How this was made" section as not-ai', () => {
    expect(readAiLabel(ordinary.answer)).toBe('not-ai')
  })

  it('reads nothing from a response with no engagement panels: it has said neither', () => {
    const { engagementPanels, ...withoutPanels } = structuredClone(madeWithAi.answer)

    expect(engagementPanels).not.toHaveLength(0)
    expect(readAiLabel(withoutPanels)).toBeNull()
  })

  it('reads nothing from panels without the structured description, where the section would be', () => {
    const answer = structuredClone(ordinary.answer)
    answer.engagementPanels = answer.engagementPanels
      .filter(panel => panel.engagementPanelSectionListRenderer?.content?.structuredDescriptionContentRenderer === undefined)

    expect(answer.engagementPanels).not.toHaveLength(0)
    expect(readAiLabel(answer)).toBeNull()
  })

  it('reads nothing from anything that is not a response', () => {
    expect(readAiLabel(undefined)).toBeNull()
    expect(readAiLabel(null)).toBeNull()
    expect(readAiLabel({ engagementPanels: 'nonsense' })).toBeNull()
  })

  it('does not take the "AI" words for the label: only the help answer counts', () => {
    const relabelled = structuredClone(autoDubbed.answer)
    const json = JSON.stringify(relabelled).replace('Auto-dubbed', 'Made with AI')

    expect(readAiLabel(JSON.parse(json))).toBe('not-ai')
  })
})
