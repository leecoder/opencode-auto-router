/**
 * Heuristic classifier — wraps the existing LiteLLM-port scorer
 * (`classifyRequest`) as one pluggable backend.
 *
 * Confidence is derived from the weighted score's distance to the tier
 * boundary that was crossed (normalized to [0,1] with a saturating curve);
 * the reasoning override keeps full confidence, mirroring its decisive role.
 */

import { classifyRequest } from "../classifier"
import type { ClassifierInput } from "../classifier"
import type { ClassifierFn, ClassifierRequest, ClassifierVerdict } from "./types"

export interface HeuristicClassifierOptions {
  scorer: ClassifierInput
  /** Tiers that short-circuit before any other backend runs */
  shortCircuitTiers?: readonly string[]
}

const BOUNDARY_KEYS = ["simple_medium", "medium_complex", "complex_reasoning"] as const
type BoundaryKey = (typeof BOUNDARY_KEYS)[number]

const TIER_BELOW: Record<string, BoundaryKey | null> = {
  SIMPLE: "simple_medium",
  MEDIUM: "medium_complex",
  COMPLEX: "complex_reasoning",
  REASONING: null,
}

/** Distance from the nearest crossed boundary, saturating at 0.15 → 1.0 */
function marginConfidence(score: number, tier: string, boundaries: Record<BoundaryKey, number>): number {
  const below = TIER_BELOW[tier]
  // Distance to the boundary crossed on the way UP to this tier
  const upper = below ? boundaries[below] : boundaries.complex_reasoning + 0.25
  const distance = tier === "SIMPLE" ? boundaries.simple_medium - score : upper - score
  const clamped = Math.max(0, Math.min(0.15, Math.abs(distance)))
  return 0.5 + (clamped / 0.15) * 0.5
}

export function createHeuristicClassifier(options: HeuristicClassifierOptions): ClassifierFn {
  return async (request: ClassifierRequest): Promise<ClassifierVerdict> => {
    const started = performance.now()
    try {
      const result = classifyRequest(options.scorer, request.prompt, request.systemPrompt)
      const confidence = result.cause === "reasoning_override"
        ? 1
        : marginConfidence(result.score, result.tier, options.scorer.tierBoundaries)
      return {
        kind: "heuristic",
        tier: result.tier,
        confidence,
        reason: result.cause === "reasoning_override" ? "reasoning override" : `score=${result.score.toFixed(2)}`,
        latencyMs: performance.now() - started,
        ok: true,
      }
    } catch (error: unknown) {
      return {
        kind: "heuristic",
        tier: "MEDIUM",
        confidence: 0,
        reason: "heuristic failed",
        latencyMs: performance.now() - started,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
