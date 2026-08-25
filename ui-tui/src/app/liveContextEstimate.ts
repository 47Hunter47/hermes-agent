import { estimateTokensRough } from '../lib/text.js'
import type { Usage } from '../types.js'

// Live context-window estimate for the status bar (#18260).
//
// The gateway's 1 Hz `session.usage` ticker (tui_gateway/server.py
// `_start_usage_ticker`) samples the agent's token counters, but those only
// advance when an API call completes (conversation_loop.py, on
// `response.usage`). During a long single thinking/response phase the
// counters are frozen, so the status bar's context gauge stays stuck and
// jumps in one step when the turn ends — observed as e.g. 60% -> 100% in a
// single frame on llama.cpp + thinking models.
//
// The TUI already receives the streamed model output (thinking.delta /
// reasoning.delta / message.delta / message.interim), so the in-flight
// tokens are estimated client-side and added to the last authoritative
// `context_used` reading. The estimate is a display-only overlay: every
// authoritative reading (session.usage tick, message.complete usage,
// session.info usage) replaces it — adoptAuthoritativeUsage() resets the
// streamed counter because the next prompt already includes everything
// streamed before that reading.

export interface LiveContextState {
  /**
   * Last authoritative current-window occupancy (`context_used`), or null
   * when the backend reports none (external engines without
   * last_prompt_tokens — no gauge to overlay on, by design #50421).
   */
  base: number | null
  /** Estimated tokens streamed since the last authoritative reading. */
  streamed: number
}

export const createLiveContextState = (): LiveContextState => ({ base: null, streamed: 0 })

/**
 * Adopt an authoritative usage snapshot as the new base. A reading that
 * carries `context_used` re-anchors the estimate — but only when that value
 * actually changes. The gateway's 1 Hz ticker re-emits while *other* fields
 * (calls, active_subagents) move and `context_used` is frozen; resetting on
 * every such frame would kill the running estimate and re-freeze the gauge.
 * A snapshot without `context_used` (external engines, #50421) leaves the
 * running estimate untouched.
 */
export const adoptAuthoritativeUsage = (state: LiveContextState, usage: Partial<Usage> | undefined): void => {
  if (!usage) {
    return
  }

  const used = usage.context_used

  if (typeof used === 'number' && used > 0 && used !== state.base) {
    state.base = used
    state.streamed = 0
  }
}

/** Fold another chunk of streamed model output into the running estimate. */
export const addStreamedText = (state: LiveContextState, text: string | undefined): void => {
  if (text) {
    state.streamed += estimateTokensRough(text)
  }
}

/**
 * Project the estimate onto a status-bar Usage patch, or null when there is
 * nothing to show (no base reading, no known context window, or no progress
 * yet — the latter keeps the gauge at its authoritative value instead of
 * re-rendering with an identical number).
 */
export const liveContextPatch = (state: LiveContextState, usage: Usage): Partial<Usage> | null => {
  if (state.base == null || !usage.context_max || state.streamed <= 0) {
    return null
  }

  const context_used = state.base + state.streamed

  return {
    context_percent: Math.max(0, Math.min(100, Math.round((context_used / usage.context_max) * 100))),
    context_used
  }
}
