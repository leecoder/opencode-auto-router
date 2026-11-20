import { Plugin } from '@opencode/plugin';
import { Context } from '@opencode/plugin/promise/plugin';
import { Tier, NormalizedPluginConfig } from './config.js';
import { ClassifierInput } from './classifier.js';
import { C as ClassifierFn, a as ClassifierVerdict } from './bert-D9JFYvfp.js';
export { r as resolveTierFromLabel } from './bert-D9JFYvfp.js';

/**
 * Heuristic classifier — wraps the existing LiteLLM-port scorer
 * (`classifyRequest`) as one pluggable backend.
 *
 * Confidence is derived from the weighted score's distance to the tier
 * boundary that was crossed (normalized to [0,1] with a saturating curve);
 * the reasoning override keeps full confidence, mirroring its decisive role.
 */

interface HeuristicClassifierOptions {
    scorer: ClassifierInput;
    /** Tiers that short-circuit before any other backend runs */
    shortCircuitTiers?: readonly string[];
}
declare function createHeuristicClassifier(options: HeuristicClassifierOptions): ClassifierFn;

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

type ClassifierCombination = "priority" | "vote";
interface OrchestratorOptions {
    backends: ClassifierFn[];
    /** Kinds in run order, e.g. ["heuristic", "bert", "apple-fm"] */
    order: string[];
    combination: ClassifierCombination;
    /** Below this, a backend's verdict is ignored (priority mode only) */
    minConfidence: number;
    /** These tiers end evaluation immediately when a backend returns them */
    shortCircuitTiers: readonly string[];
}
interface OrchestratedResult {
    tier: Tier;
    confidence: number;
    cause: string;
    signals: string[];
    /** Per-backend verdicts for notify logging */
    verdicts: ClassifierVerdict[];
}
declare function orchestrate(options: OrchestratorOptions, request: {
    prompt: string;
    systemPrompt?: string;
}): Promise<OrchestratedResult>;

interface LegacyHooks {
    event?: (input: {
        event: {
            type: string;
            properties: {
                sessionID?: string;
                error?: {
                    name?: string;
                };
                info?: {
                    role?: string;
                    time?: {
                        completed?: number;
                    };
                    error?: unknown;
                    sessionID?: string;
                    providerID?: string;
                    modelID?: string;
                };
            };
        };
    }) => Promise<void>;
    "chat.message"?: (input: unknown, output: unknown) => Promise<void>;
}
interface ChatMessageInput {
    sessionID?: string;
    agent?: string;
    model?: {
        providerID?: string;
        modelID?: string;
    };
    messageID?: string;
    variant?: string;
}
interface ChatMessageOutput {
    message: Record<string, unknown> & {
        model?: {
            providerID: string;
            modelID: string;
            variant?: string;
        };
    };
    parts: Array<{
        type?: string;
        text?: string;
    }>;
}
declare function createAutoRouter(): LegacyHooks;
declare function createAutoRouterWithConfig(config: NormalizedPluginConfig): LegacyHooks;
declare function createAutoRouterV2WithConfig(config: NormalizedPluginConfig, context: Context): Promise<() => Promise<void>>;
declare const pluginModule: Plugin.Plugin;

export { type ChatMessageInput, type ChatMessageOutput, ClassifierFn, ClassifierVerdict, type LegacyHooks, type OrchestratedResult, type OrchestratorOptions, createAutoRouter, createAutoRouterV2WithConfig, createAutoRouterWithConfig, createHeuristicClassifier, pluginModule as default, orchestrate };
