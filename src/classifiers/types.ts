/**
 * Shared contract for every classifier backend (heuristic / bert / apple-fm).
 *
 * A classifier receives the already-stripped human prompt text and returns a
 * tier plus a confidence in [0,1] and a short human-readable reason used in
 * notify logs. Classifiers never throw to callers — errors are surfaced as
 * `ok: false` results so the orchestrator can fall back to other backends.
 */

import type { Tier } from "../config"

export type ClassifierKind = "heuristic" | "bert" | "apple-fm"

export interface ClassifierVerdict {
  /** Backend that produced this verdict */
  kind: ClassifierKind
  tier: Tier
  /** Confidence in [0, 1]; heuristic derives it from margin, models from softmax */
  confidence: number
  /** Short explanation for notify logs, e.g. "score=0.42 margin=0.27" */
  reason: string
  /** Wall-clock duration of this single backend in ms */
  latencyMs: number
  /** False when the backend errored or was unavailable; `error` carries why */
  ok: boolean
  error?: string
}

export interface ClassifierRequest {
  prompt: string
  systemPrompt?: string
}

/** Async predicate implemented by every backend. Must never reject. */
export type ClassifierFn = (request: ClassifierRequest) => Promise<ClassifierVerdict>
