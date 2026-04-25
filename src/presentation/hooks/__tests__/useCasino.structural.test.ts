// Structural/characterization test for useCasino (M1 baseline).
//
// useCasino depends on DIContext + ErrorContext, which makes a full
// renderHook test bulky at the baseline stage. This test records the
// public module surface so later lanes (F2 listener lifecycle) cannot
// silently rename or drop exports.
//
// Deep lifecycle coverage is deferred — it will be added alongside the
// F2 refactor that actually changes the listener model, ensuring the
// test reflects the post-refactor contract rather than the current quirks.

import { describe, expect, it } from 'vitest'
import * as useCasinoModule from '../useCasino'

describe('useCasino — structural baseline', () => {
  it('exports useCasino as a callable function', () => {
    expect(useCasinoModule).toHaveProperty('useCasino')
    expect(typeof (useCasinoModule as { useCasino: unknown }).useCasino).toBe('function')
  })

  it('exports ConnectionStatus and CasinoProvider types at runtime (TS-only OK)', () => {
    // ConnectionStatus / CasinoProvider are type aliases and erased at runtime.
    // This test just asserts the module does not crash on import and any
    // runtime exports remain accessible. When F2 changes the module, this
    // assertion serves as a canary that the module still loads.
    expect(useCasinoModule).toBeTruthy()
  })
})
