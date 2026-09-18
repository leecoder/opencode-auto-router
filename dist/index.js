import {
  classifyRequest,
  stripReminderBlocks
} from "./chunk-Q4MCVQEK.js";
import {
  findRouterForModel,
  loadConfig
} from "./chunk-KN2NSH7R.js";
import {
  modelKey,
  normalizeConfig
} from "./chunk-3H3TGZND.js";

// src/classifiers/heuristic.ts
var TIER_BELOW = {
  SIMPLE: "simple_medium",
  MEDIUM: "medium_complex",
  COMPLEX: "complex_reasoning",
  REASONING: null
};
function marginConfidence(score, tier, boundaries) {
  const below = TIER_BELOW[tier];
  const upper = below ? boundaries[below] : boundaries.complex_reasoning + 0.25;
  const distance = tier === "SIMPLE" ? boundaries.simple_medium - score : upper - score;
  const clamped = Math.max(0, Math.min(0.15, Math.abs(distance)));
  return 0.5 + clamped / 0.15 * 0.5;
}
function createHeuristicClassifier(options) {
  return async (request) => {
    const started = performance.now();
    try {
      const result = classifyRequest(options.scorer, request.prompt, request.systemPrompt);
      const confidence = result.cause === "reasoning_override" ? 1 : marginConfidence(result.score, result.tier, options.scorer.tierBoundaries);
      return {
        kind: "heuristic",
        tier: result.tier,
        confidence,
        reason: result.cause === "reasoning_override" ? "reasoning override" : `score=${result.score.toFixed(2)}`,
        latencyMs: performance.now() - started,
        ok: true
      };
    } catch (error) {
      return {
        kind: "heuristic",
        tier: "MEDIUM",
        confidence: 0,
        reason: "heuristic failed",
        latencyMs: performance.now() - started,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };
}

// src/classifiers/bert.ts
var DEFAULT_BERT_MODEL = "mustafacolakoglu94/llm-query-complexity-classifier-onnx";
var DEFAULT_LABEL_TO_TIER = {
  LOW: "SIMPLE",
  MEDIUM: "MEDIUM",
  HIGH: "COMPLEX"
};
var pipelinePromise = null;
var pipelineKey = "";
function resolveTierFromLabel(label, resolver) {
  if (!resolver) return DEFAULT_LABEL_TO_TIER[label.toUpperCase()] ?? null;
  if (typeof resolver === "function") return resolver(label);
  const mapped = resolver[label] ?? resolver[label.toUpperCase()];
  return mapped ?? null;
}
async function loadPipeline(options) {
  const key = `${options.model}:${options.onnxFile ?? ""}:${options.device ?? ""}`;
  if (pipelinePromise && pipelineKey === key) return pipelinePromise;
  pipelinePromise = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    return await pipeline("text-classification", options.model, {
      dtype: "q8",
      device: options.device ?? "cpu"
    });
  })();
  pipelineKey = key;
  return pipelinePromise;
}
function createBertClassifier(options = {}) {
  const model = options.model ?? DEFAULT_BERT_MODEL;
  const timeoutMs = options.timeoutMs ?? 1e4;
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
      const pipe = await loadPipeline({ model, onnxFile: options.onnxFile, device: options.device });
      const infer = pipe(request.prompt);
      const timeout = new Promise(
        (_, reject) => setTimeout(() => reject(new Error(`bert timeout after ${timeoutMs}ms`)), timeoutMs)
      );
      const outputs = (await Promise.race([infer, timeout]))[0];
      if (!outputs?.label) return fail("bert returned no label");
      const tier = resolveTierFromLabel(outputs.label, options.labelToTier);
      if (!tier) return fail(`unmapped label: ${outputs.label}`);
      return {
        kind: "bert",
        tier,
        confidence: outputs.score,
        reason: `label=${outputs.label} p=${outputs.score.toFixed(2)}`,
        latencyMs: performance.now() - started,
        ok: true
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}

// src/classifiers/apple.ts
var TIER_LABELS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
var DEFAULT_INSTRUCTIONS = "You are a prompt complexity classifier for an LLM router. Judge how demanding the prompt is for the model that must answer it. SIMPLE: greetings, quick factual lookups, single-step asks. MEDIUM: normal coding or explanation tasks. COMPLEX: multi-file changes, architecture work, nuanced analysis. REASONING: deep multi-step logic, math proofs, algorithm design.";
var TIER_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: [...TIER_LABELS] }
  },
  required: ["tier"]
};
var modulePromise = null;
var availabilityCache = null;
async function loadModule() {
  if (!modulePromise) {
    modulePromise = import("@meridius-labs/apple-on-device-ai");
  }
  return modulePromise;
}
function parseTier(raw) {
  if (!raw) return null;
  const normalized = raw.trim().toUpperCase();
  return TIER_LABELS.includes(normalized) ? normalized : null;
}
function createAppleFmClassifier(options = {}) {
  const timeoutMs = options.timeoutMs ?? 15e3;
  return async (request) => {
    const started = performance.now();
    const fail = (error) => ({
      kind: "apple-fm",
      tier: "MEDIUM",
      confidence: 0,
      reason: "apple-fm unavailable",
      latencyMs: performance.now() - started,
      ok: false,
      error
    });
    try {
      const mod = await loadModule();
      if (typeof mod.structured !== "function" || !mod.appleAISDK?.checkAvailability) {
        return fail("apple-on-device-ai: structured API not found");
      }
      if (!availabilityCache?.available) {
        const availability = await mod.appleAISDK.checkAvailability();
        availabilityCache = { available: availability.available === true };
        if (!availabilityCache.available) {
          return fail(`apple intelligence unavailable: ${availability.reason}`);
        }
      }
      const prompt = `${options.instructions ?? DEFAULT_INSTRUCTIONS}
Classify the following prompt into exactly one tier.

Prompt:
${request.prompt}`;
      const timeout = new Promise(
        (_, reject) => setTimeout(() => reject(new Error(`apple-fm timeout after ${timeoutMs}ms`)), timeoutMs)
      );
      const result = await Promise.race([
        mod.structured({ prompt, schema: TIER_SCHEMA, maxTokens: 30 }),
        timeout
      ]);
      const tier = parseTier(result.object?.tier);
      if (!tier) return fail(`unrecognized tier: ${result.object?.tier ?? "(none)"}`);
      return {
        kind: "apple-fm",
        tier,
        confidence: 0.85,
        reason: `apple-fm=${tier}`,
        latencyMs: performance.now() - started,
        ok: true
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(message);
    }
  };
}

// src/classifiers/orchestrator.ts
var MEDIUM_FALLBACK = {
  kind: "heuristic",
  tier: "MEDIUM",
  confidence: 0,
  reason: "all classifiers failed",
  latencyMs: 0,
  ok: false
};
async function orchestrate(options, request) {
  const { backends, combination, minConfidence, shortCircuitTiers } = options;
  const run = async (backend) => {
    try {
      return await backend(request);
    } catch (error) {
      return {
        kind: "heuristic",
        tier: "MEDIUM",
        confidence: 0,
        reason: "backend threw",
        latencyMs: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };
  if (backends.length === 0) {
    return { tier: MEDIUM_FALLBACK.tier, confidence: 0, cause: "none", signals: [], verdicts: [MEDIUM_FALLBACK] };
  }
  if (combination === "vote") {
    const settled = await Promise.all(backends.map(run));
    const oks = settled.filter((v) => v.ok);
    if (oks.length === 0) {
      return { tier: "MEDIUM", confidence: 0, cause: "all-failed", signals: [], verdicts: settled };
    }
    const winner = oks.reduce((best, v) => v.confidence > best.confidence ? v : best, oks[0]);
    const disagree = new Set(oks.map((v) => v.tier)).size > 1;
    return {
      tier: winner.tier,
      confidence: winner.confidence,
      cause: disagree ? "vote-contested" : "vote-unanimous",
      signals: settled.map((v) => `${v.kind}:${v.ok ? v.tier : "ERR"}`),
      verdicts: settled
    };
  }
  const verdicts = [];
  for (const backend of backends) {
    const verdict = await run(backend);
    verdicts.push(verdict);
    if (!verdict.ok) continue;
    if (shortCircuitTiers.includes(verdict.tier)) {
      return {
        tier: verdict.tier,
        confidence: verdict.confidence,
        cause: `${verdict.kind}-short-circuit`,
        signals: [`${verdict.kind}: ${verdict.reason}`],
        verdicts
      };
    }
    if (verdict.confidence >= minConfidence) {
      return {
        tier: verdict.tier,
        confidence: verdict.confidence,
        cause: verdict.kind,
        signals: [`${verdict.kind}: ${verdict.reason}`],
        verdicts
      };
    }
  }
  const lastResort = verdicts.find((v) => v.ok) ?? MEDIUM_FALLBACK;
  return {
    tier: lastResort.tier,
    confidence: lastResort.confidence,
    cause: `${lastResort.kind}-low-confidence`,
    signals: verdicts.map((v) => `${v.kind}: ${v.ok ? v.reason : v.error ?? "failed"}`),
    verdicts
  };
}

// src/index.ts
function extractText(parts) {
  return parts?.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n").trim() ?? "";
}
function splitModel(ref) {
  const [providerID, ...rest] = ref.split("/");
  return { providerID, modelID: rest.join("/") };
}
function targetFor(router, tier) {
  const base = splitModel(router.tierModels[tier]);
  const variant = router.tierVariants?.[tier];
  return variant ? { ...base, variant } : base;
}
function agentMatches(router, agent) {
  if (!agent) return true;
  if (router.excludeAgents?.some((name) => name.toLowerCase() === agent.toLowerCase())) return false;
  if (router.agents && !router.agents.some((name) => name.toLowerCase() === agent.toLowerCase())) return false;
  return true;
}
var CLASSIFIER_SHORT_CIRCUIT_DEFAULT = ["SIMPLE", "REASONING"];
function buildOrchestratorOptions(router) {
  const options = router.classifierOptions;
  const backends = router.classifiers.map((kind) => {
    if (kind === "bert") {
      const kindOptions = options.bert ?? {};
      return createBertClassifier({
        model: kindOptions.model,
        onnxFile: kindOptions.onnxFile,
        labelToTier: kindOptions.labelToTier ? kindOptions.labelToTier : void 0,
        timeoutMs: kindOptions.timeoutMs
      });
    }
    if (kind === "apple-fm") {
      const kindOptions = options["apple-fm"] ?? {};
      return createAppleFmClassifier({
        timeoutMs: kindOptions.timeoutMs,
        instructions: kindOptions.instructions
      });
    }
    return createHeuristicClassifier({
      scorer: {
        codeKeywords: router.codeKeywords,
        reasoningKeywords: router.reasoningKeywords,
        technicalKeywords: router.technicalKeywords,
        simpleKeywords: router.simpleKeywords,
        dimensionWeights: router.dimensionWeights,
        tierBoundaries: router.tierBoundaries,
        tokenThresholds: router.tokenThresholds
      },
      shortCircuitTiers: options.heuristic?.shortCircuitTiers ?? CLASSIFIER_SHORT_CIRCUIT_DEFAULT
    });
  });
  const firstPriority = router.classifiers.find((kind) => kind === "heuristic" || kind === "bert") ?? router.classifiers[0];
  const minConfidence = options[firstPriority ?? "heuristic"]?.minConfidence ?? 0.5;
  return {
    backends,
    order: [...router.classifiers],
    combination: router.classifierCombination,
    minConfidence,
    shortCircuitTiers: options.heuristic?.shortCircuitTiers ?? CLASSIFIER_SHORT_CIRCUIT_DEFAULT
  };
}
function createAutoRouter() {
  return createAutoRouterWithConfig(normalizeConfig(loadConfig()));
}
function createAutoRouterWithConfig(config) {
  const sessionTiers = /* @__PURE__ */ new Map();
  const sessionFirstMessage = /* @__PURE__ */ new Map();
  const orchestrators = new Map(
    config.routers.map((router) => [router.name, buildOrchestratorOptions(router)])
  );
  const route = async (input, output) => {
    if (!config.enabled) return;
    const router = findRouterForModel({
      config,
      providerID: input.model?.providerID ?? output.message.model?.providerID,
      modelID: input.model?.modelID ?? output.message.model?.modelID
    });
    if (!router) return;
    if (!agentMatches(router, input.agent)) return;
    const sessionID = input.sessionID ?? "";
    const stateKey = `${router.name}:${sessionID}`;
    const promptText = extractText(output.parts);
    const humanText = stripReminderBlocks(promptText);
    if (!humanText.trim()) return;
    const selectedRef = modelKey(
      input.model?.providerID ?? output.message.model?.providerID,
      input.model?.modelID ?? output.message.model?.modelID
    ) ?? "";
    if (router.pinSession) {
      const pinned = sessionTiers.get(stateKey);
      if (pinned) {
        const pinnedTarget = targetFor(router, pinned);
        const pinnedRef = modelKey(pinnedTarget.providerID, pinnedTarget.modelID);
        if (selectedRef !== pinnedRef) {
          output.message.model = { ...pinnedTarget };
        } else if (pinnedTarget.variant && input.variant !== pinnedTarget.variant) {
          output.message.model = { ...pinnedTarget };
        }
        return;
      }
    }
    if (router.firstMessageOnly) {
      const isFirst = sessionFirstMessage.get(stateKey) !== true;
      sessionFirstMessage.set(stateKey, true);
      if (!isFirst && !router.pinSession) return;
    }
    const orchestratorOptions = orchestrators.get(router.name);
    if (!orchestratorOptions) return;
    const result = await orchestrate(orchestratorOptions, { prompt: humanText });
    const target = targetFor(router, result.tier);
    const targetRef = modelKey(target.providerID, target.modelID);
    const sameModel = selectedRef === targetRef;
    const sameVariant = !target.variant || input.variant === target.variant;
    if (sameModel && sameVariant) {
      sessionTiers.set(stateKey, result.tier);
      return;
    }
    output.message.model = { ...target };
    sessionTiers.set(stateKey, result.tier);
    if (config.notify) {
      const label = router.tierLabels[result.tier] ?? result.tier;
      const conf = result.confidence.toFixed(2);
      const verdict = result.signals[0] ?? "";
      const targetLabel = target.variant ? `${targetRef} (${target.variant})` : targetRef;
      console.log(
        `[auto-router] ${router.name}: ${label} (conf=${conf}, cause=${result.cause}${verdict ? `, ${verdict}` : ""}) \u2192 ${targetLabel}`
      );
    }
  };
  return {
    "chat.message": async (input, output) => {
      await route(input, output);
    }
  };
}
var pluginModule = {
  id: "opencode-auto-router",
  server: async () => createAutoRouter()
};
var index_default = pluginModule;
export {
  createAutoRouter,
  createAutoRouterWithConfig,
  createHeuristicClassifier,
  index_default as default,
  orchestrate,
  resolveTierFromLabel
};
