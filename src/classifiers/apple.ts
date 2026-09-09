/**
 * Apple Foundation Models classifier backend — macOS 26+ on-device LLM as a
 * tier judge, via `@meridius-labs/apple-on-device-ai` (Node/Bun bindings over
 * Apple's FoundationModels framework, darwin-only, Apple Silicon).
 *
 * `structured()` uses Apple's guided generation with a JSON schema, so the
 * model must answer with exactly one tier label — prose parsing cannot fail.
 * The import is deferred: on non-Apple or non-macOS-26 machines the dynamic
 * import or the availability check throws and the backend reports failure,
 * letting the orchestrator fall back to earlier backends.
 *
 * Measured on-device latency (M-series, warm): ~250-350ms per call. Use this
 * backend for low-frequency arbitration, not as the only classifier.
 */

import type { Tier } from "../config"
import type { ClassifierFn, ClassifierRequest, ClassifierVerdict } from "./types"

export interface AppleFmClassifierOptions {
  /** Hard deadline for the whole call; on expiry the backend reports failure */
  timeoutMs?: number
  /** Extra instructions prepended to the built-in classification prompt */
  instructions?: string
}

const TIER_LABELS: readonly Tier[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]

const DEFAULT_INSTRUCTIONS =
  "You are a prompt complexity classifier for an LLM router. " +
  "Judge how demanding the prompt is for the model that must answer it. " +
  "SIMPLE: greetings, quick factual lookups, single-step asks. " +
  "MEDIUM: normal coding or explanation tasks. " +
  "COMPLEX: multi-file changes, architecture work, nuanced analysis. " +
  "REASONING: deep multi-step logic, math proofs, algorithm design."

const TIER_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: [...TIER_LABELS] },
  },
  required: ["tier"],
} as const

interface StructuredModule {
  structured(options: {
    prompt: string
    schema: unknown
    maxTokens?: number
  }): Promise<{ text: string; object: { tier?: string } }>
}

interface AvailabilityModule extends StructuredModule {
  appleAISDK: { checkAvailability(): Promise<{ available: boolean; reason: string }> }
}

let modulePromise: Promise<AvailabilityModule> | null = null
let availabilityCache: { available: boolean } | null = null

async function loadModule(): Promise<AvailabilityModule> {
  if (!modulePromise) {
    modulePromise = import("@meridius-labs/apple-on-device-ai") as Promise<AvailabilityModule>
  }
  return modulePromise
}

function parseTier(raw: string | undefined): Tier | null {
  if (!raw) return null
  const normalized = raw.trim().toUpperCase()
  return (TIER_LABELS as readonly string[]).includes(normalized) ? (normalized as Tier) : null
}

export function createAppleFmClassifier(options: AppleFmClassifierOptions = {}): ClassifierFn {
  const timeoutMs = options.timeoutMs ?? 15_000

  return async (request: ClassifierRequest): Promise<ClassifierVerdict> => {
    const started = performance.now()
    const fail = (error: string): ClassifierVerdict => ({
      kind: "apple-fm",
      tier: "MEDIUM",
      confidence: 0,
      reason: "apple-fm unavailable",
      latencyMs: performance.now() - started,
      ok: false,
      error,
    })

    try {
      const mod = await loadModule()
      if (typeof mod.structured !== "function" || !mod.appleAISDK?.checkAvailability) {
        return fail("apple-on-device-ai: structured API not found")
      }

      if (!availabilityCache?.available) {
        const availability = await mod.appleAISDK.checkAvailability()
        availabilityCache = { available: availability.available === true }
        if (!availabilityCache.available) {
          return fail(`apple intelligence unavailable: ${availability.reason}`)
        }
      }

      const prompt =
        `${options.instructions ?? DEFAULT_INSTRUCTIONS}\n` +
        `Classify the following prompt into exactly one tier.\n\nPrompt:\n${request.prompt}`

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`apple-fm timeout after ${timeoutMs}ms`)), timeoutMs),
      )
      const result = await Promise.race([
        mod.structured({ prompt, schema: TIER_SCHEMA, maxTokens: 30 }),
        timeout,
      ])

      const tier = parseTier(result.object?.tier)
      if (!tier) return fail(`unrecognized tier: ${result.object?.tier ?? "(none)"}`)

      return {
        kind: "apple-fm",
        tier,
        confidence: 0.85,
        reason: `apple-fm=${tier}`,
        latencyMs: performance.now() - started,
        ok: true,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(message)
    }
  }
}

/** Test hook: reset the cached module so stubs can be injected cleanly */
export function __resetAppleFmModule(): void {
  modulePromise = null
  availabilityCache = null
}
