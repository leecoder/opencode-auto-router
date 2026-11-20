import { Plugin } from '@opencode/plugin';
import { Context } from '@opencode/plugin/promise/plugin';
import { Tier, NormalizedPluginConfig } from './config.js';
import { ClassifierInput } from './classifier.js';

/**
 * Shared contract for every classifier backend (heuristic / bert / apple-fm).
 *
 * A classifier receives the already-stripped human prompt text and returns a
 * tier plus a confidence in [0,1] and a short human-readable reason used in
 * notify logs. Classifiers never throw to callers — errors are surfaced as
 * `ok: false` results so the orchestrator can fall back to other backends.
 */

type ClassifierKind = "heuristic" | "bert" | "apple-fm";
interface ClassifierVerdict {
    /** Backend that produced this verdict */
    kind: ClassifierKind;
    tier: Tier;
    /** Confidence in [0, 1]; heuristic derives it from margin, models from softmax */
    confidence: number;
    /** Short explanation for notify logs, e.g. "score=0.42 margin=0.27" */
    reason: string;
    /** Wall-clock duration of this single backend in ms */
    latencyMs: number;
    /** False when the backend errored or was unavailable; `error` carries why */
    ok: boolean;
    error?: string;
}
interface ClassifierRequest {
    prompt: string;
    systemPrompt?: string;
}
/** Async predicate implemented by every backend. Must never reject. */
type ClassifierFn = (request: ClassifierRequest) => Promise<ClassifierVerdict>;

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
 * BERT-style local classifier backend via `@huggingface/transformers`
 * (transformers.js on onnxruntime-node).
 *
 * The model must be an ONNX-exported text-classification model whose labels
 * map onto our tiers. Default: `mustafacolakoglu94/llm-query-complexity-classifier-onnx`
 * — ModernBERT fine-tune of anasnassar/llm-query-complexity-classifier
 * (Apache-2.0, labels LOW/MEDIUM/HIGH, quantized weights included, 8k context).
 *
 * `@huggingface/transformers` is an optional dependency: importing is deferred
 * until first use so installs without it (or on machines where the native
 * onnxruntime binary is unavailable) keep working with the heuristic backend.
 * First inference downloads weights to the transformers cache (~144MB for the
 * quantized default) and takes seconds; warm inference is ~10-30ms on M-series.
 */

/** Resolved once per classify() call from a map or an identity function */
type LabelToTierResolver = (label: string) => Tier;
interface BertClassifierOptions {
    /** HF model id with onnx/* weights, or local path. Default: see file header */
    model?: string;
    /** ONNX file variant inside the repo (e.g. "model_quantized.onnx", "model.onnx") */
    onnxFile?: string;
    /** Maximum prompt tokens passed to the model. Defaults to 1024 to bound CPU and memory cost. */
    maxInputTokens?: number;
    /** Optional ONNX Runtime CPU intra-op thread limit */
    intraOpNumThreads?: number;
    /** Transform pipeline output labels into tiers. Default: LOW/MEDIUM/HIGH mapping, unknown → null */
    labelToTier?: Record<string, Tier | string> | LabelToTierResolver;
    /** Best-effort deadline for load+infer; it cannot preempt a synchronous native ONNX call */
    timeoutMs?: number;
    /** Extra pipeline options forwarded to transformers.js */
    device?: "cpu" | "auto";
}
interface TextClassificationOutput {
    label: string;
    score: number;
}
interface TextClassificationPipeline {
    (text: string): Promise<TextClassificationOutput[]>;
    tokenizer: {
        (text: string, options: {
            padding: false;
            truncation: false;
        }): {
            input_ids: {
                data: ArrayLike<number | bigint>;
            };
        };
        model_max_length: number;
        _tokenizerConfig: {
            model_max_length?: number;
        };
        decode(tokenIDs: Array<number | bigint>, options: {
            skip_special_tokens: true;
        }): string;
    };
}
declare function bertPipelineCacheKey(options: Pick<BertClassifierOptions, "model" | "onnxFile" | "device" | "intraOpNumThreads">): string;
declare function resolveTierFromLabel(label: string, resolver: BertClassifierOptions["labelToTier"]): Tier | null;
declare function boundPrompt(pipe: TextClassificationPipeline, prompt: string, maxInputTokens: number): {
    prompt: string;
    truncated: boolean;
};
declare function resolveOnnxModelOptions(onnxFile: string): {
    model_file_name: string;
    dtype: "q8" | "fp32";
};

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

export { type ChatMessageInput, type ChatMessageOutput, type ClassifierFn, type ClassifierVerdict, type LegacyHooks, type OrchestratedResult, type OrchestratorOptions, bertPipelineCacheKey, boundPrompt as boundBertPrompt, createAutoRouter, createAutoRouterV2WithConfig, createAutoRouterWithConfig, createHeuristicClassifier, pluginModule as default, orchestrate, resolveOnnxModelOptions, resolveTierFromLabel };
