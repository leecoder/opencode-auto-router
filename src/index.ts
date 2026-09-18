import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { normalizeConfig, type NormalizedPluginConfig, type NormalizedRouter, type Tier } from "./config"
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
  const orchestrators = new Map<string, OrchestratorOptions>(
    config.routers.map((router) => [router.name, buildOrchestratorOptions(router)] as const),
  )

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
    const stateKey = `${router.name}:${sessionID}`

    const promptText = extractText(output.parts)
    const humanText = stripReminderBlocks(promptText)
    if (!humanText.trim()) return

    const selectedRef =
      modelKey(
        input.model?.providerID ?? output.message.model?.providerID,
        input.model?.modelID ?? output.message.model?.modelID,
      ) ?? ""

    if (router.pinSession) {
      const pinned = sessionTiers.get(stateKey)
      if (pinned) {
        const pinnedTarget = targetFor(router, pinned)
        const pinnedRef = modelKey(pinnedTarget.providerID, pinnedTarget.modelID)
        if (selectedRef !== pinnedRef) {
          output.message.model = { ...pinnedTarget }
        } else if (pinnedTarget.variant && input.variant !== pinnedTarget.variant) {
          output.message.model = { ...pinnedTarget }
        }
        return
      }
    }

    if (router.firstMessageOnly) {
      const isFirst = sessionFirstMessage.get(stateKey) !== true
      sessionFirstMessage.set(stateKey, true)
      if (!isFirst && !router.pinSession) return
    }

    const orchestratorOptions = orchestrators.get(router.name)
    if (!orchestratorOptions) return

    const result: OrchestratedResult = await orchestrate(orchestratorOptions, { prompt: humanText })

    const target = targetFor(router, result.tier)
    const targetRef = modelKey(target.providerID, target.modelID)
    const sameModel = selectedRef === targetRef
    const sameVariant = !target.variant || input.variant === target.variant
    if (sameModel && sameVariant) {
      sessionTiers.set(stateKey, result.tier)
      return
    }

    output.message.model = { ...target }
    sessionTiers.set(stateKey, result.tier)

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
