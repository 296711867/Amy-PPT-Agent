import type { GenerationFailureInfo } from './generation-error'

export type GenerationCircuitState = {
  paused: boolean
  failure: GenerationFailureInfo | null
  occurrences: number
}

export function createGenerationCircuitBreaker(): {
  getState: () => GenerationCircuitState
  registerFailure: (failure: GenerationFailureInfo) => GenerationCircuitState
} {
  let state: GenerationCircuitState = {
    paused: false,
    failure: null,
    occurrences: 0
  }

  return {
    getState: () => state,
    registerFailure: (failure) => {
      if (failure.scope !== 'system') return state

      const occurrences =
        state.failure?.fingerprint === failure.fingerprint ? state.occurrences + 1 : 1
      state = {
        // Transient provider failures need a matching second occurrence before they
        // stop the deck. Auth, quota and storage failures are not useful to retry.
        paused: !failure.retryable || occurrences >= 2,
        failure,
        occurrences
      }
      return state
    }
  }
}
