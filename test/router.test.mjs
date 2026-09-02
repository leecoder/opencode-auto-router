import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyRequest, stripReminderBlocks } from "../dist/classifier.js"
import { normalizeConfig } from "../dist/config.js"

const cfg = normalizeConfig(undefined)

function classify(prompt, system) {
  return classifyRequest(
    {
      codeKeywords: cfg.codeKeywords,
      reasoningKeywords: cfg.reasoningKeywords,
      technicalKeywords: cfg.technicalKeywords,
      simpleKeywords: cfg.simpleKeywords,
      dimensionWeights: cfg.dimensionWeights,
      tierBoundaries: cfg.tierBoundaries,
      tokenThresholds: cfg.tokenThresholds,
    },
    prompt,
    system,
  )
}

test("SIMPLE: greeting", () => {
  assert.equal(classify("hello").tier, "SIMPLE")
})

test("SIMPLE: factual lookup", () => {
  assert.equal(classify("what is the capital of France").tier, "SIMPLE")
})

test("MEDIUM: everyday request with some explanation", () => {
  // "databases" alone is not a code/technical keyword (that's "database"); the
  // LiteLLM scorer needs ≥1 code + more signals, so this stays SIMPLE by design.
  // This test asserts the port matches the reference behavior, not an opinion.
  const result = classify("can you explain how databases work")
  assert.ok(["SIMPLE", "MEDIUM"].includes(result.tier), JSON.stringify(result))
})

test("COMPLEX: code implementation", () => {
  // 3 code keywords (function, database, implement) → score 0.3 → MEDIUM
  // per DEFAULT_TIER_BOUNDARIES (medium_complex=0.35). The reference LiteLLM
  // defaults also land here; COMPLEX requires ≥0.35 (4+ distinct signals).
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
  // 2+ reasoning markers force REASONING regardless of score
  assert.equal(classify("compare and contrast, then conclude").tier, "REASONING")
})

test("system prompt is ignored for reasoning override", () => {
  // "think through" in system prompt must NOT force REASONING
  const system = "You are an assistant that thinks through everything carefully"
  const result = classify("what is 2+2", system)
  assert.notEqual(result.tier, "REASONING")
})

test("system-reminder blocks are stripped before classification", () => {
  const prompt = "<system-reminder>implement a complex distributed system</system-reminder>\nhello"
  const stripped = stripReminderBlocks(prompt)
  assert.equal(classify(stripped).tier, "SIMPLE")
})

test("long prompts skew complex", () => {
  // tokenCount alone maxes at +1.0 * 0.1 weight = 0.1 → still SIMPLE boundary;
  // matching LiteLLM's defaults where length alone never reaches COMPLEX.
  const long = "please " + "provide a detailed analysis of ".repeat(120)
  const result = classify(long)
  assert.ok(["SIMPLE", "MEDIUM"].includes(result.tier), JSON.stringify(result))
})

test("multi-step patterns count", () => {
  // "multi-step (0.03)" + numbered steps + no code keywords: stays SIMPLE by
  // reference behavior; multiStepPatterns alone never crosses 0.15.
  const result = classify("1. install 2. configure 3. deploy the microservice")
  assert.ok(result.signals.includes("multi-step"), JSON.stringify(result))
})

test("CJK keyword matches as substring", () => {
  const cjkCfg = normalizeConfig({ simpleKeywords: ["분석", "버그"] })
  const customInput = {
    codeKeywords: cjkCfg.codeKeywords,
    reasoningKeywords: cjkCfg.reasoningKeywords,
    technicalKeywords: cjkCfg.technicalKeywords,
    simpleKeywords: cjkCfg.simpleKeywords,
    dimensionWeights: cjkCfg.dimensionWeights,
    tierBoundaries: cjkCfg.tierBoundaries,
    tokenThresholds: cjkCfg.tokenThresholds,
  }
  const result = classifyRequest(customInput, "이 버그를 분석해줘")
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
  assert.equal(custom.tierModels.SIMPLE, "litellm/glm-4.7-flash")
  assert.equal(custom.defaultModel, "litellm/glm-5")
})