// src/classifiers/bert.ts
var DEFAULT_BERT_MODEL = "mustafacolakoglu94/llm-query-complexity-classifier-onnx";
var DEFAULT_LABEL_TO_TIER = {
  LOW: "SIMPLE",
  MEDIUM: "MEDIUM",
  HIGH: "COMPLEX"
};
var pipelinePromises = /* @__PURE__ */ new Map();
function bertPipelineCacheKey(options) {
  return `${options.model ?? DEFAULT_BERT_MODEL}:${options.onnxFile ?? ""}:${options.device ?? ""}:${options.intraOpNumThreads ?? ""}`;
}
function resolveTierFromLabel(label, resolver) {
  if (!resolver) return DEFAULT_LABEL_TO_TIER[label.toUpperCase()] ?? null;
  if (typeof resolver === "function") return resolver(label);
  const mapped = resolver[label] ?? resolver[label.toUpperCase()];
  return mapped ?? null;
}
function boundPrompt(pipe, prompt, maxInputTokens) {
  const tokenIDs = Array.from(pipe.tokenizer(prompt, { padding: false, truncation: false }).input_ids.data);
  const modelLimit = pipe.tokenizer.model_max_length;
  const effectiveLimit = Number.isFinite(modelLimit) && modelLimit > 0 ? Math.min(maxInputTokens, Math.floor(modelLimit)) : maxInputTokens;
  if (tokenIDs.length <= effectiveLimit) return { prompt, truncated: false, strategy: "none" };
  const marker = "\n[...middle omitted...]\n";
  const markerTokenCount = Array.from(
    pipe.tokenizer(marker, { padding: false, truncation: false }).input_ids.data
  ).length;
  if (effectiveLimit <= markerTokenCount + 2) {
    return {
      prompt: pipe.tokenizer.decode(tokenIDs.slice(0, effectiveLimit), { skip_special_tokens: true }),
      truncated: true,
      strategy: "prefix"
    };
  }
  const windowTokens = Math.floor((effectiveLimit - markerTokenCount) / 2);
  const head = pipe.tokenizer.decode(tokenIDs.slice(0, windowTokens), { skip_special_tokens: true });
  const tail = pipe.tokenizer.decode(tokenIDs.slice(-windowTokens), { skip_special_tokens: true });
  const boundedPrompt = `${head}${marker}${tail}`;
  const boundedTokenCount = Array.from(
    pipe.tokenizer(boundedPrompt, { padding: false, truncation: false }).input_ids.data
  ).length;
  if (boundedTokenCount <= effectiveLimit)
    return { prompt: boundedPrompt, truncated: true, strategy: "head+tail" };
  return {
    prompt: pipe.tokenizer.decode(tokenIDs.slice(0, effectiveLimit), { skip_special_tokens: true }),
    truncated: true,
    strategy: "prefix"
  };
}
function resolveOnnxModelOptions(onnxFile) {
  const fileName = onnxFile.split(/[\\/]/).at(-1)?.replace(/\.onnx$/i, "");
  if (!fileName) throw new Error("onnxFile must include an ONNX filename");
  const quantized = fileName.endsWith("_quantized");
  return {
    model_file_name: quantized ? fileName.slice(0, -"_quantized".length) : fileName,
    dtype: quantized ? "q8" : "fp32"
  };
}
async function loadPipeline(options) {
  const key = bertPipelineCacheKey(options);
  const cached = pipelinePromises.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    const onnxOptions = options.onnxFile ? resolveOnnxModelOptions(options.onnxFile) : { dtype: "q8" };
    const pipe = await pipeline("text-classification", options.model, {
      ...onnxOptions,
      device: options.device ?? "cpu",
      session_options: options.intraOpNumThreads ? { intraOpNumThreads: options.intraOpNumThreads } : void 0
    });
    return pipe;
  })();
  pipelinePromises.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (pipelinePromises.get(key) === pending) pipelinePromises.delete(key);
    throw error;
  }
}
function createBertClassifier(options = {}) {
  const model = options.model ?? DEFAULT_BERT_MODEL;
  const timeoutMs = options.timeoutMs ?? 1e4;
  const requestedMaxInputTokens = options.maxInputTokens ?? 1024;
  const maxInputTokens = Number.isFinite(requestedMaxInputTokens) ? Math.max(1, Math.floor(requestedMaxInputTokens)) : 1024;
  return async (request) => {
    const started = performance.now();
    const fail = (error) => ({
      kind: "bert",
      tier: "MEDIUM",
      confidence: 0,
      reason: "bert unavailable",
      latencyMs: performance.now() - started,
      ok: false,
      error
    });
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bert timeout after ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        return await Promise.race([
          (async () => {
            const pipe = await loadPipeline({
              model,
              onnxFile: options.onnxFile,
              device: options.device,
              intraOpNumThreads: options.intraOpNumThreads
            });
            const bounded = boundPrompt(pipe, request.prompt, maxInputTokens);
            const outputs = (await pipe(bounded.prompt))[0];
            if (!outputs?.label) return fail("bert returned no label");
            const tier = resolveTierFromLabel(outputs.label, options.labelToTier);
            if (!tier) return fail(`unmapped label: ${outputs.label}`);
            return {
              kind: "bert",
              tier,
              confidence: outputs.score,
              reason: `label=${outputs.label} p=${outputs.score.toFixed(2)} tokens<=${maxInputTokens}${bounded.truncated ? ` truncated=${bounded.strategy}` : ""}`,
              latencyMs: performance.now() - started,
              ok: true
            };
          })(),
          timeout
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}
function resetBertPipelineCache() {
  pipelinePromises.clear();
}

export {
  bertPipelineCacheKey,
  resolveTierFromLabel,
  boundPrompt,
  resolveOnnxModelOptions,
  createBertClassifier,
  resetBertPipelineCache
};
