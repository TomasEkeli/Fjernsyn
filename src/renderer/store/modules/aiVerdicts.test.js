import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DBAiVerdictHandlers } from '../../../datastores/handlers/index'
import aiVerdicts from './aiVerdicts'

// What the store reads and writes, answered and recorded instead
vi.mock('../../../datastores/handlers/index', () => ({
  DBAiVerdictHandlers: {
    find: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
  },
}))

const NOW = Date.parse('2026-10-04T12:00:00Z')

function freshState() {
  return { aiVerdicts: {} }
}

/** @param {{ aiVerdicts: Record<string, boolean> }} state */
function contextFor(state) {
  return { state, commit: (type, payload) => aiVerdicts.mutations[type](state, payload) }
}

describe('the AI verdicts store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  it('loads every verdict kept at startup, ai and not-ai alike', async () => {
    DBAiVerdictHandlers.find.mockResolvedValueOnce([
      { _id: '8Kstkyi3RoE', ai: true, checkedAt: 1 },
      { _id: 'dQw4w9WgXcQ', ai: false, checkedAt: 2 },
      { _id: 'brokenbroke' },
    ])
    const state = freshState()

    await aiVerdicts.actions.grabAiVerdicts(contextFor(state))

    expect(aiVerdicts.getters.getAiVerdicts(state)).toEqual({ '8Kstkyi3RoE': true, dQw4w9WgXcQ: false })
  })

  it('keeps a verdict found while loading over the one on disk', async () => {
    DBAiVerdictHandlers.find.mockResolvedValueOnce([{ _id: '8Kstkyi3RoE', ai: false, checkedAt: 1 }])
    const state = { aiVerdicts: { '8Kstkyi3RoE': true } }

    await aiVerdicts.actions.grabAiVerdicts(contextFor(state))

    expect(state.aiVerdicts).toEqual({ '8Kstkyi3RoE': true })
  })

  it('writes a new verdict through to the datastore, with when it was found', async () => {
    const state = freshState()

    await aiVerdicts.actions.recordAiVerdict(contextFor(state), { videoId: '8Kstkyi3RoE', verdict: 'ai' })
    await aiVerdicts.actions.recordAiVerdict(contextFor(state), { videoId: 'dQw4w9WgXcQ', verdict: 'not-ai' })

    expect(state.aiVerdicts).toEqual({ '8Kstkyi3RoE': true, dQw4w9WgXcQ: false })
    expect(DBAiVerdictHandlers.upsert.mock.calls).toEqual([
      ['8Kstkyi3RoE', true, NOW],
      ['dQw4w9WgXcQ', false, NOW],
    ])
  })

  it('does not write a verdict it already has', async () => {
    const state = { aiVerdicts: { '8Kstkyi3RoE': true } }

    await aiVerdicts.actions.recordAiVerdict(contextFor(state), { videoId: '8Kstkyi3RoE', verdict: 'ai' })

    expect(DBAiVerdictHandlers.upsert).not.toHaveBeenCalled()
  })
})
