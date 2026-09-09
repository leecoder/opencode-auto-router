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
  /** Transform pipeline output labels into tiers. Default: LOW/MEDIUM/HIGH mapping, unknown → null */
  labelToTier?: Record<string, Tier | string> | LabelToTierResolver
  /** Hard deadline for load+infer; on expiry the backend reports failure */
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

type TextClassificationPipeline = (
  text: string,
) => Promise<TextClassificationOutput[]>

/** Module-level singleton: one model load per process regardless of routers */
let pipelinePromise: Promise<TextClassificationPipeline> | null = null
let pipelineKey = ""

export function resolveTierFromLabel(
  label: string,
  resolver: BertClassifierOptions["labelToTier"],
): Tier | null {
  if (!resolver) return DEFAULT_LABEL_TO_TIER[label.toUpperCase()] ?? null
  if (typeof resolver === "function") return resolver(label)
  const mapped = resolver[label] ?? resolver[label.toUpperCase()]
  return (mapped as Tier | undefined) ?? null
}

async function loadPipeline(options: BertClassifierOptions & { model: string }): Promise<TextClassificationPipeline> {
  const key = `${options.model}:${options.onnxFile ?? ""}:${options.device ?? ""}`
  if (pipelinePromise && pipelineKey === key) return pipelinePromise
  // Model config changed — drop the old load and rebuild.
  pipelinePromise = (async () => {
    const { pipeline } = await import("@huggingface/transformers")
    return (await pipeline("text-classification", options.model, {
      dtype: "q8",
      device: options.device ?? "cpu",
    })) as unknown as TextClassificationPipeline
  })()
  pipelineKey = key
  return pipelinePromise
}

export function createBertClassifier(options: BertClassifierOptions = {}): ClassifierFn {
  const model = options.model ?? DEFAULT_BERT_MODEL
  const timeoutMs = options.timeoutMs ?? 10_000

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
      const pipe = await loadPipeline({ model, onnxFile: options.onnxFile, device: options.device })
      const infer = pipe(request.prompt)
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`bert timeout after ${timeoutMs}ms`)), timeoutMs),
      )
      const outputs = (await Promise.race([infer, timeout]))[0] as TextClassificationOutput | undefined
      if (!outputs?.label) return fail("bert returned no label")

      const tier = resolveTierFromLabel(outputs.label, options.labelToTier)
      if (!tier) return fail(`unmapped label: ${outputs.label}`)

      return {
        kind: "bert",
        tier,
        confidence: outputs.score,
        reason: `label=${outputs.label} p=${outputs.score.toFixed(2)}`,
        latencyMs: performance.now() - started,
        ok: true,
      }
    } catch (error: unknown) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
}

/** Test hook: forget the cached pipeline so each test run loads cleanly */
export function resetBertPipelineCache(): void {
  pipelinePromise = null
  pipelineKey = ""
}
