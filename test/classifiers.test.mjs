import { test } from "node:test"
import assert from "node:assert/strict"
import {
  orchestrate,
  resolveTierFromLabel,
} from "../dist/index.js"
import {
  bertPipelineCacheKey,
  boundPrompt as boundBertPrompt,
  resolveOnnxModelOptions,
} from "../dist/classifiers/bert.js"
import { createHeuristicClassifier } from "../dist/index.js"
import { normalizeConfig, normalizeRouter } from "../dist/config.js"
import { createAutoRouterWithConfig } from "../dist/index.js"

// --- orchestrator: priority mode ---

const ok = (kind, tier, confidence, reason = `${kind} says ${tier}`) => ({
  kind,
  tier,
  confidence,
  reason,
  latencyMs: 1,
  ok: true,
})

const failed = (kind, error = "unavailable") => ({
  kind,
  tier: "MEDIUM",
  confidence: 0,
  reason: "unavailable",
  latencyMs: 1,
  ok: false,
  error,
})

const staticBackend = (verdict) => async () => verdict
const failingBackend = async () => {
  throw new Error("boom")
}

function priorityOptions(backends, overrides = {}) {
  return {
    backends,
    order: backends.map((_, i) => `b${i}`),
    combination: "priority",
    minConfidence: 0.5,
    shortCircuitTiers: ["SIMPLE", "REASONING"],
    ...overrides,
  }
}

test("priority: first confident verdict wins", async () => {
  const result = await orchestrate(
    priorityOptions([
      staticBackend(ok("heuristic", "MEDIUM", 0.9)),
      staticBackend(ok("bert", "COMPLEX", 0.99)),
    ]),
    { prompt: "hello" },
  )
  assert.equal(result.tier, "MEDIUM")
  assert.equal(result.cause, "heuristic")
})

test("priority: low-confidence backend is skipped, next one answers", async () => {
  const result = await orchestrate(
    priorityOptions([
      staticBackend(ok("heuristic", "MEDIUM", 0.3)),
      staticBackend(ok("bert", "COMPLEX", 0.9)),
    ]),
    { prompt: "hello" },
  )
  assert.equal(result.tier, "COMPLEX")
  assert.equal(result.cause, "bert")
})

test("priority: short-circuit tier ends evaluation before later backends", async () => {
  let laterRan = false
  const result = await orchestrate(
    priorityOptions([
      staticBackend(ok("heuristic", "REASONING", 0.4)),
      staticBackend(async () => {
        laterRan = true
        return ok("bert", "SIMPLE", 0.99)
      }),
    ]),
    { prompt: "hello" },
  )
  assert.equal(result.tier, "REASONING")
  assert.equal(result.cause, "heuristic-short-circuit")
  assert.equal(laterRan, false)
})

test("priority: all failed → MEDIUM fallback", async () => {
  const result = await orchestrate(
    priorityOptions([staticBackend(failed("bert")), staticBackend(failed("apple-fm"))]),
    { prompt: "hello" },
  )
  assert.equal(result.tier, "MEDIUM")
  assert.equal(result.cause, "heuristic-low-confidence")
})

test("priority: rejected backend throws → skipped without crashing", async () => {
  const result = await orchestrate(
    priorityOptions([failingBackend, staticBackend(ok("bert", "COMPLEX", 0.9))]),
    { prompt: "hello" },
  )
  assert.equal(result.tier, "COMPLEX")
  assert.equal(result.cause, "bert")
  assert.equal(result.verdicts[0].ok, false)
  assert.equal(result.verdicts[0].error, "boom")
})

test("priority: empty backends → MEDIUM with cause=none", async () => {
  const result = await orchestrate(priorityOptions([]), { prompt: "hello" })
  assert.equal(result.tier, "MEDIUM")
  assert.equal(result.cause, "none")
})

// --- orchestrator: vote mode ---

test("vote: unanimous keeps the tier and reports vote-unanimous", async () => {
  const result = await orchestrate(
    {
      backends: [staticBackend(ok("heuristic", "SIMPLE", 0.9)), staticBackend(ok("bert", "SIMPLE", 0.8))],
      order: ["heuristic", "bert"],
      combination: "vote",
      minConfidence: 0.5,
      shortCircuitTiers: [],
    },
    { prompt: "hello" },
  )
  assert.equal(result.tier, "SIMPLE")
  assert.equal(result.cause, "vote-unanimous")
})

test("vote: contested → highest confidence wins", async () => {
  const result = await orchestrate(
    {
      backends: [staticBackend(ok("heuristic", "SIMPLE", 0.7)), staticBackend(ok("bert", "COMPLEX", 0.95))],
      order: ["heuristic", "bert"],
      combination: "vote",
      minConfidence: 0.5,
      shortCircuitTiers: [],
    },
    { prompt: "hello" },
  )
  assert.equal(result.tier, "COMPLEX")
  assert.equal(result.cause, "vote-contested")
  assert.deepEqual(result.signals, ["heuristic:SIMPLE", "bert:COMPLEX"])
})

test("vote: all fail → MEDIUM", async () => {
  const result = await orchestrate(
    {
      backends: [staticBackend(failed("bert"))],
      order: ["bert"],
      combination: "vote",
      minConfidence: 0.5,
      shortCircuitTiers: [],
    },
    { prompt: "hello" },
  )
  assert.equal(result.tier, "MEDIUM")
  assert.equal(result.cause, "all-failed")
})

// --- heuristic classifier wrapper ---

test("heuristic wrapper: greeting → SIMPLE with confidence", async () => {
  const router = normalizeRouter({}, 0)
  const classify = createHeuristicClassifier({
    scorer: {
      codeKeywords: router.codeKeywords,
      reasoningKeywords: router.reasoningKeywords,
      technicalKeywords: router.technicalKeywords,
      simpleKeywords: router.simpleKeywords,
      dimensionWeights: router.dimensionWeights,
      tierBoundaries: router.tierBoundaries,
      tokenThresholds: router.tokenThresholds,
    },
  })
  const verdict = await classify({ prompt: "hello" })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.tier, "SIMPLE")
  assert.ok(verdict.confidence > 0.5, `confidence=${verdict.confidence}`)
})

test("heuristic wrapper: reasoning override keeps confidence 1", async () => {
  const router = normalizeRouter({}, 0)
  const classify = createHeuristicClassifier({
    scorer: {
      codeKeywords: router.codeKeywords,
      reasoningKeywords: router.reasoningKeywords,
      technicalKeywords: router.technicalKeywords,
      simpleKeywords: router.simpleKeywords,
      dimensionWeights: router.dimensionWeights,
      tierBoundaries: router.tierBoundaries,
      tokenThresholds: router.tokenThresholds,
    },
  })
  const verdict = await classify({ prompt: "think through this step by step and explain your reasoning" })
  assert.equal(verdict.tier, "REASONING")
  assert.equal(verdict.confidence, 1)
  assert.equal(verdict.reason, "reasoning override")
})

// --- bert label mapping ---

test("bert label mapping: LOW/MEDIUM/HIGH defaults", async () => {
  assert.equal(resolveTierFromLabel("LOW"), "SIMPLE")
  assert.equal(resolveTierFromLabel("medium"), "MEDIUM")
  assert.equal(resolveTierFromLabel("HIGH"), "COMPLEX")
  assert.equal(resolveTierFromLabel("UNKNOWN_LABEL"), null)
})

test("bert label mapping: custom map overrides defaults", async () => {
  const map = { LOW: "SIMPLE", MEDIUM: "MEDIUM", HIGH: "REASONING" }
  assert.equal(resolveTierFromLabel("HIGH", map), "REASONING")
  assert.equal(resolveTierFromLabel("high", map), "REASONING")
})

function fakeBertPipeline(modelMaxLength) {
  const tokenizer = (text) => ({
    input_ids: { data: Array.from(text, (character) => character.codePointAt(0)) },
  })
  tokenizer.model_max_length = modelMaxLength
  tokenizer._tokenizerConfig = {}
  tokenizer.decode = (ids) => String.fromCodePoint(...ids)
  return { tokenizer }
}

test("bert prompt bound respects the model context limit", () => {
  const pipe = fakeBertPipeline(40)
  const result = boundBertPrompt(pipe, `${"head".repeat(20)}${"tail".repeat(20)}`, 1024)
  assert.equal(result.truncated, true)
  assert.ok(pipe.tokenizer(result.prompt).input_ids.data.length <= 40)
  assert.ok(result.prompt.startsWith("headhead"))
  assert.ok(result.prompt.endsWith("tailtail"))
  assert.match(result.prompt, /middle omitted/)
})

test("bert prompt bound uses a single window when the token budget cannot fit the marker", () => {
  const pipe = fakeBertPipeline(2)
  const result = boundBertPrompt(pipe, "a very long prompt", 1)
  assert.equal(result.truncated, true)
  assert.equal(pipe.tokenizer(result.prompt).input_ids.data.length, 1)
  assert.doesNotMatch(result.prompt, /middle omitted/)
})

test("bert ONNX file option selects the configured model filename and dtype", () => {
  assert.deepEqual(resolveOnnxModelOptions("onnx/model_quantized.onnx"), {
    model_file_name: "model",
    dtype: "q8",
  })
  assert.deepEqual(resolveOnnxModelOptions("onnx/model.onnx"), {
    model_file_name: "model",
    dtype: "fp32",
  })
})

test("bert pipeline cache key excludes per-request input limits but includes session options", () => {
  const base = {
    model: "test/model",
    onnxFile: "onnx/model_quantized.onnx",
    device: "cpu",
    intraOpNumThreads: 2,
  }
  assert.equal(
    bertPipelineCacheKey({ ...base, maxInputTokens: 256 }),
    bertPipelineCacheKey({ ...base, maxInputTokens: 2048 }),
  )
  assert.notEqual(
    bertPipelineCacheKey(base),
    bertPipelineCacheKey({ ...base, intraOpNumThreads: 4 }),
  )
})

// --- config normalization ---

test("config: classifier defaults to heuristic-only", () => {
  const router = normalizeRouter({}, 0)
  assert.deepEqual(router.classifiers, ["heuristic"])
  assert.equal(router.classifierCombination, "priority")
  assert.deepEqual(router.classifierOptions, {})
})

test("config: classifier shorthand accepts a single kind", () => {
  const router = normalizeRouter({ classifier: "bert" }, 0)
  assert.deepEqual(router.classifiers, ["bert"])
})

test("config: classifiers array + vote combination", () => {
  const cfg = normalizeConfig({
    routers: [
      {
        classifiers: ["heuristic", "bert", "apple-fm"],
        classifierCombination: "vote",
        classifierOptions: {
          bert: { model: "test/model", timeoutMs: 5000, maxInputTokens: 256, intraOpNumThreads: 1 },
        },
      },
    ],
  })
  const router = cfg.routers[0]
  assert.deepEqual(router.classifiers, ["heuristic", "bert", "apple-fm"])
  assert.equal(router.classifierCombination, "vote")
  assert.equal(router.classifierOptions.bert.model, "test/model")
  assert.equal(router.classifierOptions.bert.timeoutMs, 5000)
  assert.equal(router.classifierOptions.bert.maxInputTokens, 256)
  assert.equal(router.classifierOptions.bert.intraOpNumThreads, 1)
})

test("config: BERT numeric options require positive integers", () => {
  for (const option of ["maxInputTokens", "intraOpNumThreads"]) {
    for (const value of ["512", 0, -1, 1.5]) {
      assert.throws(
        () =>
          normalizeRouter(
            { classifierOptions: { bert: { [option]: value } } },
            2,
          ),
        new RegExp(`router\\[2\\].*classifierOptions\\.bert\\.${option} must be a positive integer`),
      )
    }
  }
})

test("config: unknown classifier kinds are dropped, empty result falls back", () => {
  const router = normalizeRouter({ classifiers: ["nope", "bert"] }, 0)
  assert.deepEqual(router.classifiers, ["bert"])
  const empty = normalizeRouter({ classifiers: ["nope"] }, 0)
  assert.deepEqual(empty.classifiers, ["heuristic"])
})

test("config: shorthand router carries classifier fields", () => {
  const cfg = normalizeConfig({ classifier: "bert", tierModels: { SIMPLE: "litellm/x" } })
  assert.deepEqual(cfg.routers[0].classifiers, ["bert"])
})

// --- end-to-end through chat.message hook ---

test("chat.message: bert-configured router still routes via heuristic path when bert fails", async () => {
  const hooks = createAutoRouterWithConfig(
    normalizeConfig({
      enabled: true,
      notify: false,
      routers: [
        {
          name: "hybrid",
          classifiers: ["bert", "heuristic"],
          classifierOptions: { bert: { model: "/tmp/opencode-auto-router-missing-model" } },
          tierModels: {
            SIMPLE: "litellm/glm-4.7-flash",
            MEDIUM: "litellm/glm-5",
            COMPLEX: "litellm/sonnet-5",
            REASONING: "litellm/opus-5",
          },
        },
      ],
    }),
  )

  const output = {
    message: { model: { providerID: "auto-router", modelID: "hybrid" } },
    parts: [{ type: "text", text: "think through this step by step and explain your reasoning" }],
  }
  await hooks["chat.message"](
    { sessionID: "s-bert", agent: "build", model: { providerID: "auto-router", modelID: "hybrid" } },
    output,
  )
  // bert backend fails (module not installed in test env → error verdict),
  // heuristic short-circuits on REASONING override
  assert.deepEqual(output.message.model, { providerID: "litellm", modelID: "opus-5" })
})

test("chat.message: default heuristic-only router unchanged", async () => {
  const hooks = createAutoRouterWithConfig(
    normalizeConfig({
      enabled: true,
      notify: false,
      routers: [{ name: "legacy" }],
    }),
  )
  const output = {
    message: { model: { providerID: "auto-router", modelID: "legacy" } },
    parts: [{ type: "text", text: "hello" }],
  }
  await hooks["chat.message"](
    { sessionID: "s-legacy", agent: "build", model: { providerID: "auto-router", modelID: "legacy" } },
    output,
  )
  assert.deepEqual(output.message.model, { providerID: "litellm", modelID: "databricks/databricks-glm-5-3-flash" })
})
