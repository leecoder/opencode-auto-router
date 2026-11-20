import { Tier } from './config.js';

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
    strategy: "none" | "prefix" | "head+tail";
};
declare function resolveOnnxModelOptions(onnxFile: string): {
    model_file_name: string;
    dtype: "q8" | "fp32";
};
declare function createBertClassifier(options?: BertClassifierOptions): ClassifierFn;
/** Test hook: forget the cached pipeline so each test run loads cleanly */
declare function resetBertPipelineCache(): void;

export { type BertClassifierOptions as B, type ClassifierFn as C, type LabelToTierResolver as L, type ClassifierVerdict as a, bertPipelineCacheKey as b, boundPrompt as c, createBertClassifier as d, resetBertPipelineCache as e, resolveOnnxModelOptions as f, resolveTierFromLabel as r };
