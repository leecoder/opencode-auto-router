import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyRequest, stripReminderBlocks } from "../dist/classifier.js"
import { normalizeConfig, modelKey, normalizeRouter, DEFAULT_TIER_MODELS } from "../dist/config.js"
import { findRouterForModel } from "../dist/config-loader.js"
import { createAutoRouter } from "../dist/index.js"

const cfg = normalizeConfig(undefined)

function classify(prompt, system) {
  const router = cfg.routers[0]
  return classifyRequest(
    {
      codeKeywords: router.codeKeywords,
      reasoningKeywords: router.reasoningKeywords,
      technicalKeywords: router.technicalKeywords,
      simpleKeywords: router.simpleKeywords,
      dimensionWeights: router.dimensionWeights,
      tierBoundaries: router.tierBoundaries,
      tokenThresholds: router.tokenThresholds,
    },
    prompt,
    system,
  )
}

// --- classifier (LiteLLM port) ---

test("SIMPLE: greeting", () => {
  assert.equal(classify("hello").tier, "SIMPLE")
})

test("SIMPLE: factual lookup", () => {
  assert.equal(classify("what is the capital of France").tier, "SIMPLE")
})

test("MEDIUM: code request (3 code keywords by reference behavior)", () => {
  const result = classify("implement a function that connects to a database and handles errors")
  assert.equal(result.tier, "MEDIUM", JSON.stringify(result))
})

test("COMPLEX: refactor with technical + code keywords", () => {
  const result = classify("refactor the authentication service to scale across kubernetes with performance optimization")
  assert.ok(["COMPLEX", "REASONING"].includes(result.tier), JSON.stringify(result))
})

test("REASONING: reasoning markers", () => {
  assert.equal(classify("think through this step by step and explain your reasoning").tier, "REASONING")
})

test("REASONING override fires even with short prompt", () => {
  assert.equal(classify("compare and contrast, then conclude").tier, "REASONING")
})

test("system prompt is ignored for reasoning override", () => {
  const system = "You are an assistant that thinks through everything carefully"
  const result = classify("what is 2+2", system)
  assert.notEqual(result.tier, "REASONING")
})

test("system-reminder blocks are stripped before classification", () => {
  const prompt = "<system-reminder>implement a complex distributed system</system-reminder>\nhello"
  const stripped = stripReminderBlocks(prompt)
  assert.equal(classify(stripped).tier, "SIMPLE")
})

test("CJK keyword matches as substring", () => {
  const cjkCfg = normalizeConfig({ simpleKeywords: ["분석", "버그"] })
  const router = cjkCfg.routers[0]
  const result = classifyRequest(
    {
      codeKeywords: router.codeKeywords,
      reasoningKeywords: router.reasoningKeywords,
      technicalKeywords: router.technicalKeywords,
      simpleKeywords: router.simpleKeywords,
      dimensionWeights: router.dimensionWeights,
      tierBoundaries: router.tierBoundaries,
      tokenThresholds: router.tokenThresholds,
    },
    "이 버그를 분석해줘",
  )
  assert.equal(result.tier, "SIMPLE", JSON.stringify(result))
  assert.ok(result.signals.some((s) => s.includes("분석")), JSON.stringify(result))
})

test("custom config overrides", () => {
  const custom = normalizeConfig({
    tierModels: {
      SIMPLE: "litellm/glm-4.7-flash",
      MEDIUM: "litellm/glm-5",
      COMPLEX: "litellm/sonnet-5",
      REASONING: "litellm/opus-5",
    },
  })
  assert.equal(custom.routers[0].tierModels.SIMPLE, "litellm/glm-4.7-flash")
  assert.equal(custom.routers[0].defaultModel, "litellm/glm-5")
})

// --- trigger gating (fusion-style model selection) ---

test("findRouterForModel: auto-router/name activates routing", () => {
  const router = findRouterForModel({
    config: cfg,
    providerID: "auto-router",
    modelID: "router-0",
  })
  assert.ok(router, "auto-router/router-0 should trigger the default router")
  assert.equal(router.name, "router-0")
})

test("findRouterForModel: non-trigger model returns null (pass-through)", () => {
  assert.equal(findRouterForModel({ config: cfg, providerID: "litellm", modelID: "gpt-5.6-luna" }), null)
  assert.equal(findRouterForModel({ config: cfg, providerID: "kiro", modelID: "claude-sonnet-4-6" }), null)
  assert.equal(findRouterForModel({ config: cfg, providerID: "anthropic", modelID: "claude-opus-5" }), null)
  assert.equal(findRouterForModel({ config: cfg, providerID: "litellm", modelID: "auto-dgc" }), null)
})

test("findRouterForModel: matching is case-insensitive", () => {
  const router = findRouterForModel({
    config: cfg,
    providerID: "Auto-Router",
    modelID: "ROUTER-0",
  })
  assert.ok(router)
})

test("findRouterForModel: missing model returns null", () => {
  assert.equal(findRouterForModel({ config: cfg, providerID: "litellm" }), null)
  assert.equal(findRouterForModel({ config: cfg }), null)
})

test("multi-router: first matching name wins", () => {
  const multi = normalizeConfig({
    routers: [
      {
        name: "cheap",
        tierModels: { SIMPLE: "litellm/glm-4.7-flash", MEDIUM: "litellm/glm-5", COMPLEX: "litellm/glm-5", REASONING: "litellm/glm-5" },
      },
      {
        name: "premium",
        tierModels: { SIMPLE: "litellm/sonnet-5", MEDIUM: "litellm/sonnet-5", COMPLEX: "litellm/opus-5", REASONING: "litellm/opus-5" },
      },
    ],
  })
  assert.equal(multi.routers.length, 2)
  const hit = findRouterForModel({ config: multi, providerID: "auto-router", modelID: "cheap" })
  assert.equal(hit.name, "cheap")
})

test("multi-router: second router's distinct name matches", () => {
  const multi = normalizeConfig({
    routers: [
      { name: "cheap" },
      { name: "premium" },
    ],
  })
  const hit = findRouterForModel({ config: multi, providerID: "auto-router", modelID: "premium" })
  assert.equal(hit.name, "premium")
})

test("modelKey normalizes case", () => {
  assert.equal(modelKey("LiteLLM", "Auto-DGC"), "litellm/auto-dgc")
  assert.equal(modelKey(undefined, "x"), null)
  assert.equal(modelKey("x", undefined), null)
})

test("defaults: router name is router-0 and tiers are the documented mapping", () => {
  assert.equal(normalizeRouter({}, 0).name, "router-0")
  assert.equal(DEFAULT_TIER_MODELS.SIMPLE, "litellm/databricks/databricks-glm-5-3-flash")
  assert.equal(DEFAULT_TIER_MODELS.MEDIUM, "litellm/databricks/databricks-deepseek-v4-flash-0731")
  assert.equal(DEFAULT_TIER_MODELS.COMPLEX, "litellm/sonnet-5")
  assert.equal(DEFAULT_TIER_MODELS.REASONING, "litellm/opus-5")
})

// --- tier variant routing (reasoningEffort etc.) ---

test("normalizeRouter: tierVariants defaults to empty map", () => {
  const router = normalizeRouter({}, 0)
  assert.deepEqual(router.tierVariants, {})
})

test("normalizeRouter: tierVariants passthrough", () => {
  const router = normalizeRouter(
    {
      tierModels: { REASONING: "github-copilot/gpt-6-astra" },
      tierVariants: { REASONING: "xhigh", MEDIUM: "medium" },
    },
    0,
  )
  assert.equal(router.tierVariants.REASONING, "xhigh")
  assert.equal(router.tierVariants.MEDIUM, "medium")
  assert.equal(router.tierVariants.SIMPLE, undefined)
})

test("normalizeRouter: tier model object carries its variant", () => {
  const router = normalizeRouter(
    {
      tierModels: {
        SIMPLE: { model: "github-copilot/gpt-5.6-luna", variant: "xhigh" },
        REASONING: "litellm/opus-5",
      },
    },
    0,
  )
  assert.equal(router.tierModels.SIMPLE, "github-copilot/gpt-5.6-luna")
  assert.equal(router.tierVariants.SIMPLE, "xhigh")
  assert.equal(router.tierModels.REASONING, "litellm/opus-5")
})

test("normalizeRouter: explicit tierVariants overrides only string shorthand", () => {
  const router = normalizeRouter(
    {
      tierModels: { SIMPLE: { model: "github-copilot/gpt-5.6-luna", variant: "xhigh" } },
      tierVariants: { SIMPLE: "low", MEDIUM: "medium" },
    },
    0,
  )
  assert.equal(router.tierVariants.SIMPLE, "xhigh")
  assert.equal(router.tierVariants.MEDIUM, "medium")
})

test("chat.message routes with variant when tier model already selected", async () => {
  const { createAutoRouterWithConfig } = await import("../dist/index.js")
  const hooks = createAutoRouterWithConfig(
    normalizeConfig({
      enabled: true,
      notify: false,
      routers: [
        {
          name: "gpt",
          tierModels: {
            SIMPLE: "litellm/gpt-5.6-luna",
            MEDIUM: "litellm/gpt-5.6-luna",
            COMPLEX: "litellm/gpt-5.6-sol",
            REASONING: "litellm/gpt-5.6-sol",
          },
          tierVariants: {
            SIMPLE: "low",
            MEDIUM: "medium",
            COMPLEX: "xhigh",
            REASONING: "xhigh",
          },
        },
      ],
    }),
  )

  const output = {
    message: { model: { providerID: "auto-router", modelID: "gpt" } },
    parts: [{ type: "text", text: "hello" }],
  }
  await hooks["chat.message"](
    { sessionID: "s1", agent: "build", model: { providerID: "auto-router", modelID: "gpt" } },
    output,
  )
  assert.deepEqual(output.message.model, {
    providerID: "litellm",
    modelID: "gpt-5.6-luna",
    variant: "low",
  })
})

test("chat.message swaps variant when same model different effort", async () => {
  const { createAutoRouterWithConfig } = await import("../dist/index.js")
  const hooks = createAutoRouterWithConfig(
    normalizeConfig({
      enabled: true,
      notify: false,
      routers: [
        {
          name: "gpt",
          tierModels: {
            SIMPLE: "litellm/gpt-5.6-luna",
            MEDIUM: "litellm/gpt-5.6-luna",
            COMPLEX: "litellm/gpt-5.6-sol",
            REASONING: "litellm/gpt-5.6-sol",
          },
          tierVariants: {
            SIMPLE: "low",
            MEDIUM: "medium",
            COMPLEX: "xhigh",
            REASONING: "xhigh",
          },
        },
      ],
    }),
  )

  const output = {
    message: { model: { providerID: "auto-router", modelID: "gpt", variant: "xhigh" } },
    parts: [{ type: "text", text: "hello" }],
  }
  await hooks["chat.message"](
    { sessionID: "s2", agent: "build", model: { providerID: "auto-router", modelID: "gpt" }, variant: "xhigh" },
    output,
  )
  assert.deepEqual(output.message.model, {
    providerID: "litellm",
    modelID: "gpt-5.6-luna",
    variant: "low",
  })
})

test("chat.message routes using an inline tier model variant", async () => {
  const { createAutoRouterWithConfig } = await import("../dist/index.js")
  const hooks = createAutoRouterWithConfig(
    normalizeConfig({
      enabled: true,
      notify: false,
      routers: [{
        name: "inline",
        tierModels: {
          SIMPLE: { model: "litellm/gpt-5.6-luna", variant: "low" },
          MEDIUM: "litellm/gpt-5.6-luna",
          COMPLEX: "litellm/sonnet-5",
          REASONING: "litellm/opus-5",
        },
      }],
    }),
  )
  const output = {
    message: { model: { providerID: "auto-router", modelID: "inline" } },
    parts: [{ type: "text", text: "hello" }],
  }
  await hooks["chat.message"](
    { sessionID: "s-inline", agent: "build", model: { providerID: "auto-router", modelID: "inline" } },
    output,
  )
  assert.deepEqual(output.message.model, { providerID: "litellm", modelID: "gpt-5.6-luna", variant: "low" })
})
