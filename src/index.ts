import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  normalizeConfig,
  type NormalizedPluginConfig,
  type NormalizedRouter,
  type Tier,
  type TierModelValue,
} from "./config"
import { findRouterForModel, loadConfig, modelKey } from "./config-loader"
import { stripReminderBlocks } from "./classifier"
import { createHeuristicClassifier } from "./classifiers/heuristic"
import { createBertClassifier, resolveTierFromLabel } from "./classifiers/bert"
import { createAppleFmClassifier } from "./classifiers/apple"
import { orchestrate, type OrchestratorOptions, type OrchestratedResult } from "./classifiers/orchestrator"
import type { ClassifierFn, ClassifierVerdict } from "./classifiers/types"

type PluginModule = {
  id: string
  server: (input: PluginInput) => Promise<Hooks>
}

export interface ChatMessageInput {
  sessionID?: string
  agent?: string
  model?: { providerID?: string; modelID?: string }
  messageID?: string
  variant?: string
}

export interface ChatMessageOutput {
  message: Record<string, unknown> & {
    model?: { providerID: string; modelID: string; variant?: string }
  }
  parts: Array<{ type?: string; text?: string }>
}

function extractText(parts: Array<{ type?: string; text?: string }>): string {
  return (
    parts
      ?.filter((part) => part.type === "text" && part.text)
      .map((part) => part.text as string)
      .join("\n")
      .trim() ?? ""
  )
}

function splitModel(ref: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = ref.split("/")
  return { providerID: providerID!, modelID: rest.join("/") }
}

interface ModelTarget {
  providerID: string
  modelID: string
  variant?: string
}

function targetFor(router: NormalizedRouter, tier: Tier): ModelTarget {
  const base = splitModel(router.tierModels[tier])
  const variant = router.tierVariants?.[tier]
  return variant ? { ...base, variant } : base
}

function targetForValue(value: TierModelValue): ModelTarget {
  if (typeof value === "string") return splitModel(value)
  const base = splitModel(value.model)
  return value.variant ? { ...base, variant: value.variant } : base
}

function targetKey(target: ModelTarget): string {
  return `${modelKey(target.providerID, target.modelID) ?? ""}#${target.variant ?? ""}`
}

function targetsFor(router: NormalizedRouter, tier: Tier): readonly ModelTarget[] {
  const primary = targetFor(router, tier)
  const fallbacks = (router.tierFallbacks[tier] ?? []).map(targetForValue)
  const targets: ModelTarget[] = []
  const seen = new Set<string>()
  for (const target of [primary, ...fallbacks]) {
    const key = targetKey(target)
    if (seen.has(key)) continue
    seen.add(key)
    targets.push(target)
  }
  return targets
}

type ActiveAttempt = {
  stateKey: string
  targetKey: string
}

function agentMatches(router: ReturnType<typeof normalizeConfig>["routers"][number], agent?: string): boolean {
  if (!agent) return true
  if (router.excludeAgents?.some((name) => name.toLowerCase() === agent.toLowerCase())) return false
  if (router.agents && !router.agents.some((name) => name.toLowerCase() === agent.toLowerCase())) return false
  return true
}

const CLASSIFIER_SHORT_CIRCUIT_DEFAULT = ["SIMPLE", "REASONING"] as const

function buildOrchestratorOptions(router: NormalizedRouter): OrchestratorOptions {
  const options = router.classifierOptions
  const backends: ClassifierFn[] = router.classifiers.map((kind) => {
    if (kind === "bert") {
      const kindOptions = options.bert ?? {}
      return createBertClassifier({
        model: kindOptions.model,
        onnxFile: kindOptions.onnxFile,
        labelToTier: kindOptions.labelToTier
          ? (kindOptions.labelToTier as Record<string, string>)
          : undefined,
        timeoutMs: kindOptions.timeoutMs,
      })
    }
    if (kind === "apple-fm") {
      const kindOptions = options["apple-fm"] ?? {}
      return createAppleFmClassifier({
        timeoutMs: kindOptions.timeoutMs,
        instructions: kindOptions.instructions,
      })
    }
    return createHeuristicClassifier({
      scorer: {
        codeKeywords: router.codeKeywords,
        reasoningKeywords: router.reasoningKeywords,
        technicalKeywords: router.technicalKeywords,
        simpleKeywords: router.simpleKeywords,
        dimensionWeights: router.dimensionWeights,
        tierBoundaries: router.tierBoundaries,
        tokenThresholds: router.tokenThresholds,
      },
      shortCircuitTiers: options.heuristic?.shortCircuitTiers ?? CLASSIFIER_SHORT_CIRCUIT_DEFAULT,
    })
  })

  const firstPriority = router.classifiers.find((kind) => kind === "heuristic" || kind === "bert")
    ?? router.classifiers[0]
  const minConfidence =
    options[firstPriority ?? "heuristic"]?.minConfidence ?? 0.5

  return {
    backends,
    order: [...router.classifiers],
    combination: router.classifierCombination,
    minConfidence,
    shortCircuitTiers: options.heuristic?.shortCircuitTiers ?? CLASSIFIER_SHORT_CIRCUIT_DEFAULT,
  }
}

export function createAutoRouter(): Hooks {
  return createAutoRouterWithConfig(normalizeConfig(loadConfig()))
}

export function createAutoRouterWithConfig(config: NormalizedPluginConfig): Hooks {
  // Per-router session state, keyed by `${routerName}:${sessionID}` so multiple
  // routers can coexist without one pin bleeding into another.
  const sessionTiers = new Map<string, Tier>()
  const sessionFirstMessage = new Map<string, boolean>()
  const failedTargets = new Map<string, Set<string>>()
  const activeAttempts = new Map<string, ActiveAttempt>()
  const orchestrators = new Map<string, OrchestratorOptions>(
    config.routers.map((router) => [router.name, buildOrchestratorOptions(router)] as const),
  )

  const selectTarget = (router: NormalizedRouter, tier: Tier, stateKey: string): ModelTarget => {
    const failed = failedTargets.get(stateKey)
    const target = targetsFor(router, tier).find((candidate) => !failed?.has(targetKey(candidate)))
    if (target) return target
    failed?.clear()
    return targetFor(router, tier)
  }

  const rememberAttempt = (sessionID: string | undefined, stateKey: string, target: ModelTarget): void => {
    if (!sessionID) return
    activeAttempts.set(sessionID, { stateKey, targetKey: targetKey(target) })
  }

  const route = async (input: ChatMessageInput, output: ChatMessageOutput): Promise<void> => {
    if (!config.enabled) return

    // Any other selection passes through untouched — manual model choice wins.
    const router = findRouterForModel({
      config,
      providerID: input.model?.providerID ?? output.message.model?.providerID,
      modelID: input.model?.modelID ?? output.message.model?.modelID,
    })
    if (!router) return
    if (!agentMatches(router, input.agent)) return

    const sessionID = input.sessionID ?? ""
    const sessionKey = `${router.name}:${sessionID}`

    const promptText = extractText(output.parts)
    const humanText = stripReminderBlocks(promptText)
    if (!humanText.trim()) return

    const selectedRef =
      modelKey(
        input.model?.providerID ?? output.message.model?.providerID,
        input.model?.modelID ?? output.message.model?.modelID,
      ) ?? ""

    if (router.pinSession) {
      const pinned = sessionTiers.get(sessionKey)
      if (pinned) {
        const fallbackStateKey = `${sessionKey}:${pinned}`
        const pinnedTarget = selectTarget(router, pinned, fallbackStateKey)
        const pinnedRef = modelKey(pinnedTarget.providerID, pinnedTarget.modelID)
        if (selectedRef !== pinnedRef) {
          output.message.model = { ...pinnedTarget }
        } else if (pinnedTarget.variant && input.variant !== pinnedTarget.variant) {
          output.message.model = { ...pinnedTarget }
        }
        rememberAttempt(input.sessionID, fallbackStateKey, pinnedTarget)
        return
      }
    }

    if (router.firstMessageOnly) {
      const isFirst = sessionFirstMessage.get(sessionKey) !== true
      sessionFirstMessage.set(sessionKey, true)
      if (!isFirst && !router.pinSession) return
    }

    const orchestratorOptions = orchestrators.get(router.name)
    if (!orchestratorOptions) return

    const result: OrchestratedResult = await orchestrate(orchestratorOptions, { prompt: humanText })

    const fallbackStateKey = `${sessionKey}:${result.tier}`
    const target = selectTarget(router, result.tier, fallbackStateKey)
    const targetRef = modelKey(target.providerID, target.modelID)
    const sameModel = selectedRef === targetRef
    const sameVariant = !target.variant || input.variant === target.variant
    rememberAttempt(input.sessionID, fallbackStateKey, target)
    if (sameModel && sameVariant) {
      sessionTiers.set(sessionKey, result.tier)
      return
    }

    output.message.model = { ...target }
    sessionTiers.set(sessionKey, result.tier)

    if (config.notify) {
      const label = router.tierLabels[result.tier] ?? result.tier
      const conf = result.confidence.toFixed(2)
      const verdict = result.signals[0] ?? ""
      const targetLabel = target.variant ? `${targetRef} (${target.variant})` : targetRef
      console.log(
        `[auto-router] ${router.name}: ${label} (conf=${conf}, cause=${result.cause}${verdict ? `, ${verdict}` : ""}) → ${targetLabel}`,
      )
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.error") {
        const sessionID = event.properties.sessionID
        if (!sessionID) return
        const attempt = activeAttempts.get(sessionID)
        if (!attempt) return
        const failed = failedTargets.get(attempt.stateKey) ?? new Set<string>()
        failed.add(attempt.targetKey)
        failedTargets.set(attempt.stateKey, failed)
        activeAttempts.delete(sessionID)
        return
      }

      if (event.type !== "message.updated") return
      const info = event.properties.info
      if (info.role !== "assistant" || !info.time.completed || info.error) return
      const attempt = activeAttempts.get(info.sessionID)
      if (!attempt) return
      const completedModelKey = modelKey(info.providerID, info.modelID)
      if (!completedModelKey || !attempt.targetKey.startsWith(`${completedModelKey}#`)) return
      failedTargets.delete(attempt.stateKey)
      activeAttempts.delete(info.sessionID)
    },
    "chat.message": async (input: unknown, output: unknown) => {
      await route(input as ChatMessageInput, output as ChatMessageOutput)
    },
  }
}

const pluginModule: PluginModule = {
  id: "opencode-auto-router",
  server: async () => createAutoRouter(),
}

export { resolveTierFromLabel, orchestrate, createHeuristicClassifier }
export type { OrchestratorOptions, OrchestratedResult, ClassifierFn, ClassifierVerdict }
export default pluginModule
