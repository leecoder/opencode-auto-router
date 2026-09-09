/**
 * Classifier orchestrator — combines pluggable backends into one verdict.
 *
 * Two combination modes:
 * - "priority" (default): backends run in order; the first successful, confident
 *   verdict wins. A backend whose confidence is below `minConfidence` is skipped,
 *   and a short-circuit tier ends evaluation immediately (heuristic fast path).
 * - "vote": all backends run (Promise.all); the highest-confidence tier wins,
 *   with ties broken by backend order. When backends disagree, `voted` is true
 *   and the winning reason notes the runners-up for notify logs.
 *
 * Every backend must never reject; a failed backend is skipped (priority) or
 * excluded (vote). If everything fails, the orchestrator falls back to the
 * first heuristic verdict or, failing that, the router's MEDIUM default.
 */

import type { Tier } from "../config"
import type { ClassifierFn, ClassifierVerdict } from "./types"

export type ClassifierCombination = "priority" | "vote"

export interface OrchestratorOptions {
  backends: ClassifierFn[]
  /** Kinds in run order, e.g. ["heuristic", "bert", "apple-fm"] */
  order: string[]
  combination: ClassifierCombination
  /** Below this, a backend's verdict is ignored (priority mode only) */
  minConfidence: number
  /** These tiers end evaluation immediately when a backend returns them */
  shortCircuitTiers: readonly string[]
}

export interface OrchestratedResult {
  tier: Tier
  confidence: number
  cause: string
  signals: string[]
  /** Per-backend verdicts for notify logging */
  verdicts: ClassifierVerdict[]
}

const MEDIUM_FALLBACK: ClassifierVerdict = {
  kind: "heuristic",
  tier: "MEDIUM",
  confidence: 0,
  reason: "all classifiers failed",
  latencyMs: 0,
  ok: false,
}

function firstOk(backends: ClassifierVerdict[], minConfidence: number): ClassifierVerdict | null {
  return backends.find((v) => v.ok && v.confidence >= minConfidence) ?? null
}

export async function orchestrate(
  options: OrchestratorOptions,
  request: { prompt: string; systemPrompt?: string },
): Promise<OrchestratedResult> {
  const { backends, combination, minConfidence, shortCircuitTiers } = options

  // Backends promise not to throw, but a misbehaving custom backend must not
  // take down routing — a rejection is converted to a failed verdict here.
  const run = async (backend: ClassifierFn): Promise<ClassifierVerdict> => {
    try {
      return await backend(request)
    } catch (error: unknown) {
      return {
        kind: "heuristic",
        tier: "MEDIUM",
        confidence: 0,
        reason: "backend threw",
        latencyMs: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  if (backends.length === 0) {
    return { tier: MEDIUM_FALLBACK.tier, confidence: 0, cause: "none", signals: [], verdicts: [MEDIUM_FALLBACK] }
  }

  if (combination === "vote") {
    const settled = await Promise.all(backends.map(run))
    const oks = settled.filter((v) => v.ok)
    if (oks.length === 0) {
      return { tier: "MEDIUM", confidence: 0, cause: "all-failed", signals: [], verdicts: settled }
    }
    const winner = oks.reduce((best, v) => (v.confidence > best.confidence ? v : best), oks[0]!)
    const disagree = new Set(oks.map((v) => v.tier)).size > 1
    return {
      tier: winner.tier,
      confidence: winner.confidence,
      cause: disagree ? "vote-contested" : "vote-unanimous",
      signals: settled.map((v) => `${v.kind}:${v.ok ? v.tier : "ERR"}`),
      verdicts: settled,
    }
  }

  // priority mode: sequential, first confident verdict wins
  const verdicts: ClassifierVerdict[] = []
  for (const backend of backends) {
    const verdict = await run(backend)
    verdicts.push(verdict)
    if (!verdict.ok) continue
    if (shortCircuitTiers.includes(verdict.tier)) {
      return {
        tier: verdict.tier,
        confidence: verdict.confidence,
        cause: `${verdict.kind}-short-circuit`,
        signals: [`${verdict.kind}: ${verdict.reason}`],
        verdicts,
      }
    }
    if (verdict.confidence >= minConfidence) {
      return {
        tier: verdict.tier,
        confidence: verdict.confidence,
        cause: verdict.kind,
        signals: [`${verdict.kind}: ${verdict.reason}`],
        verdicts,
      }
    }
    // Low confidence → fall through to the next backend
  }

  const lastResort = verdicts.find((v) => v.ok) ?? MEDIUM_FALLBACK
  return {
    tier: lastResort.tier,
    confidence: lastResort.confidence,
    cause: `${lastResort.kind}-low-confidence`,
    signals: verdicts.map((v) => `${v.kind}: ${v.ok ? v.reason : (v.error ?? "failed")}`),
    verdicts,
  }
}
