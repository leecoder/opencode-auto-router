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

import type { Tier } from "../config"
import type { ClassifierFn, ClassifierRequest, ClassifierVerdict } from "./types"

/** Resolved once per classify() call from a map or an identity function */
export type LabelToTierResolver = (label: string) => Tier

export interface BertClassifierOptions {
  /** HF model id with onnx/* weights, or local path. Default: see file header */
  model?: string
  /** ONNX file variant inside the repo (e.g. "model_quantized.onnx", "model.onnx") */
  onnxFile?: string
  /** Maximum prompt tokens passed to the model. Defaults to 1024 to bound CPU and memory cost. */
  maxInputTokens?: number
  /** Optional ONNX Runtime CPU intra-op thread limit */
  intraOpNumThreads?: number
  /** Transform pipeline output labels into tiers. Default: LOW/MEDIUM/HIGH mapping, unknown → null */
  labelToTier?: Record<string, Tier | string> | LabelToTierResolver
  /** Best-effort deadline for load+infer; it cannot preempt a synchronous native ONNX call */
  timeoutMs?: number
  /** Extra pipeline options forwarded to transformers.js */
  device?: "cpu" | "auto"
}

const DEFAULT_BERT_MODEL = "mustafacolakoglu94/llm-query-complexity-classifier-onnx"
const DEFAULT_LABEL_TO_TIER: Record<string, Tier> = {
  LOW: "SIMPLE",
  MEDIUM: "MEDIUM",
  HIGH: "COMPLEX",
}

interface TextClassificationOutput {
  label: string
  score: number
}

interface TextClassificationPipeline {
  (text: string): Promise<TextClassificationOutput[]>
  tokenizer: {
    (
      text: string,
      options: { padding: false; truncation: false },
    ): { input_ids: { data: ArrayLike<number | bigint> } }
    model_max_length: number
    _tokenizerConfig: { model_max_length?: number }
    decode(tokenIDs: Array<number | bigint>, options: { skip_special_tokens: true }): string
  }
}

/** Cache by load-time model options; request-only input limits do not affect the ONNX session. */
const pipelinePromises = new Map<string, Promise<TextClassificationPipeline>>()

export function bertPipelineCacheKey(
  options: Pick<BertClassifierOptions, "model" | "onnxFile" | "device" | "intraOpNumThreads">,
): string {
  return `${options.model ?? DEFAULT_BERT_MODEL}:${options.onnxFile ?? ""}:${options.device ?? ""}:${options.intraOpNumThreads ?? ""}`
}

export function resolveTierFromLabel(
  label: string,
  resolver: BertClassifierOptions["labelToTier"],
): Tier | null {
  if (!resolver) return DEFAULT_LABEL_TO_TIER[label.toUpperCase()] ?? null
  if (typeof resolver === "function") return resolver(label)
  const mapped = resolver[label] ?? resolver[label.toUpperCase()]
  return (mapped as Tier | undefined) ?? null
}

export function boundPrompt(pipe: TextClassificationPipeline, prompt: string, maxInputTokens: number) {
  const tokenIDs = Array.from(pipe.tokenizer(prompt, { padding: false, truncation: false }).input_ids.data)
  const modelLimit = pipe.tokenizer.model_max_length
  const effectiveLimit =
    Number.isFinite(modelLimit) && modelLimit > 0
      ? Math.min(maxInputTokens, Math.floor(modelLimit))
      : maxInputTokens
  if (tokenIDs.length <= effectiveLimit) return { prompt, truncated: false }

  const marker = "\n[...middle omitted...]\n"
  const markerTokenCount = Array.from(
    pipe.tokenizer(marker, { padding: false, truncation: false }).input_ids.data,
  ).length
  if (effectiveLimit <= markerTokenCount + 2) {
    return {
      prompt: pipe.tokenizer.decode(tokenIDs.slice(0, effectiveLimit), { skip_special_tokens: true }),
      truncated: true,
    }
  }

  const windowTokens = Math.floor((effectiveLimit - markerTokenCount) / 2)
  const head = pipe.tokenizer.decode(tokenIDs.slice(0, windowTokens), { skip_special_tokens: true })
  const tail = pipe.tokenizer.decode(tokenIDs.slice(-windowTokens), { skip_special_tokens: true })
  const boundedPrompt = `${head}${marker}${tail}`
  const boundedTokenCount = Array.from(
    pipe.tokenizer(boundedPrompt, { padding: false, truncation: false }).input_ids.data,
  ).length
  if (boundedTokenCount <= effectiveLimit) return { prompt: boundedPrompt, truncated: true }
  return {
    prompt: pipe.tokenizer.decode(tokenIDs.slice(0, effectiveLimit), { skip_special_tokens: true }),
    truncated: true,
  }
}

export function resolveOnnxModelOptions(onnxFile: string): { model_file_name: string; dtype: "q8" | "fp32" } {
  const fileName = onnxFile.split(/[\\/]/).at(-1)?.replace(/\.onnx$/i, "")
  if (!fileName) throw new Error("onnxFile must include an ONNX filename")
  const quantized = fileName.endsWith("_quantized")
  return {
    model_file_name: quantized ? fileName.slice(0, -"_quantized".length) : fileName,
    dtype: quantized ? "q8" : "fp32",
  }
}

async function loadPipeline(
  options: BertClassifierOptions & { model: string },
): Promise<TextClassificationPipeline> {
  const key = bertPipelineCacheKey(options)
  const cached = pipelinePromises.get(key)
  if (cached) return cached

  const pending = (async () => {
    const { pipeline } = await import("@huggingface/transformers")
    const onnxOptions = options.onnxFile
      ? resolveOnnxModelOptions(options.onnxFile)
      : { dtype: "q8" as const }
    const pipe = (await pipeline("text-classification", options.model, {
      ...onnxOptions,
      device: options.device ?? "cpu",
      session_options: options.intraOpNumThreads
        ? { intraOpNumThreads: options.intraOpNumThreads }
        : undefined,
    })) as unknown as TextClassificationPipeline
    return pipe
  })()
  pipelinePromises.set(key, pending)
  try {
    return await pending
  } catch (error) {
    if (pipelinePromises.get(key) === pending) pipelinePromises.delete(key)
    throw error
  }
}

export function createBertClassifier(options: BertClassifierOptions = {}): ClassifierFn {
  const model = options.model ?? DEFAULT_BERT_MODEL
  const timeoutMs = options.timeoutMs ?? 10_000
  const requestedMaxInputTokens = options.maxInputTokens ?? 1024
  const maxInputTokens = Number.isFinite(requestedMaxInputTokens)
    ? Math.max(1, Math.floor(requestedMaxInputTokens))
    : 1024

  return async (request: ClassifierRequest): Promise<ClassifierVerdict> => {
    const started = performance.now()
    const fail = (error: string): ClassifierVerdict => ({
      kind: "bert",
      tier: "MEDIUM",
      confidence: 0,
      reason: "bert unavailable",
      latencyMs: performance.now() - started,
      ok: false,
      error,
    })

    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bert timeout after ${timeoutMs}ms`)), timeoutMs)
      })
      try {
        return await Promise.race([
          (async () => {
            const pipe = await loadPipeline({
              model,
              onnxFile: options.onnxFile,
              device: options.device,
              intraOpNumThreads: options.intraOpNumThreads,
            })
            const bounded = boundPrompt(pipe, request.prompt, maxInputTokens)
            const outputs = (await pipe(bounded.prompt))[0] as TextClassificationOutput | undefined
            if (!outputs?.label) return fail("bert returned no label")

            const tier = resolveTierFromLabel(outputs.label, options.labelToTier)
            if (!tier) return fail(`unmapped label: ${outputs.label}`)

            return {
              kind: "bert" as const,
              tier,
              confidence: outputs.score,
              reason: `label=${outputs.label} p=${outputs.score.toFixed(2)} tokens<=${maxInputTokens}${bounded.truncated ? " truncated=head+tail" : ""}`,
              latencyMs: performance.now() - started,
              ok: true,
            }
          })(),
          timeout,
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch (error: unknown) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
}

/** Test hook: forget the cached pipeline so each test run loads cleanly */
export function resetBertPipelineCache(): void {
  pipelinePromises.clear()
}
