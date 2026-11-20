import { Plugin } from "@opencode/plugin"
import type { Context as V2PluginContext } from "@opencode/plugin/promise/plugin"
import type { SessionHooks } from "@opencode/plugin/promise/session"
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

export interface LegacyHooks {
  event?: (input: {
    event: {
      type: string
      properties: {
        sessionID?: string
        error?: { name?: string }
        info?: {
          role?: string
          time?: { completed?: number }
          error?: unknown
          sessionID?: string
          providerID?: string
          modelID?: string
        }
      }
    }
  }) => Promise<void>
  "chat.message"?: (input: unknown, output: unknown) => Promise<void>
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

const NON_MODEL_ERROR_NAMES = new Set([
  "MessageAbortedError",
  "MessageOutputLengthError",
  "ContextOverflowError",
  "ProviderAuthError",
])

const V2_NON_MODEL_ERROR_TYPES = new Set([
  "permission.rejected",
  "tool.execution",
  "provider.auth",
  "provider.content-filter",
  "provider.invalid-request",
  "provider.unsupported-operation",
])

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

export function createAutoRouter(): LegacyHooks {
  return createAutoRouterWithConfig(normalizeConfig(loadConfig()))
}

export function createAutoRouterWithConfig(config: NormalizedPluginConfig): LegacyHooks {
  // Per-router session state, keyed by `${routerName}:${sessionID}` so multiple
  // routers can coexist without one pin bleeding into another.
  const sessionTiers = new Map<string, Tier>()
  const sessionFirstMessage = new Map<string, boolean>()
  const failedTargets = new Map<string, Set<string>>()
  const activeAttempts = new Map<string, ActiveAttempt[]>()
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
    const attempts = activeAttempts.get(sessionID) ?? []
    attempts.push({ stateKey, targetKey: targetKey(target) })
    activeAttempts.set(sessionID, attempts)
  }

  const removeAttempt = (sessionID: string, index: number): ActiveAttempt | undefined => {
    const attempts = activeAttempts.get(sessionID)
    if (!attempts) return
    const [attempt] = attempts.splice(index, 1)
    if (attempts.length === 0) activeAttempts.delete(sessionID)
    return attempt
  }

  const takeNextAttempt = (sessionID: string): ActiveAttempt | undefined => removeAttempt(sessionID, 0)

  const takeCompletedAttempt = (sessionID: string, completedModelKey: string): ActiveAttempt | undefined => {
    const attempts = activeAttempts.get(sessionID)
    const index = attempts?.findIndex((attempt) =>
      attempt.targetKey.startsWith(`${completedModelKey}#`),
    )
    if (index === undefined || index < 0) return
    return removeAttempt(sessionID, index)
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
        // session.error carries no request ID, so consume attempts in terminal-event order.
        const attempt = takeNextAttempt(sessionID)
        if (!attempt) return
        if (NON_MODEL_ERROR_NAMES.has(event.properties.error?.name ?? "")) return
        const failed = failedTargets.get(attempt.stateKey) ?? new Set<string>()
        failed.add(attempt.targetKey)
        failedTargets.set(attempt.stateKey, failed)
        return
      }

      if (event.type !== "message.updated") return
      const info = event.properties.info
      if (
        !info ||
        info.role !== "assistant" ||
        !info.time?.completed ||
        info.error ||
        !info.sessionID ||
        !info.providerID ||
        !info.modelID
      )
        return
      const completedModelKey = modelKey(info.providerID, info.modelID)
      if (!completedModelKey) return
      const attempt = takeCompletedAttempt(info.sessionID, completedModelKey)
      if (!attempt) return
      failedTargets.delete(attempt.stateKey)
    },
    "chat.message": async (input: unknown, output: unknown) => {
      await route(input as ChatMessageInput, output as ChatMessageOutput)
    },
  }
}

type V2ModelSelection = {
  providerID?: string
  id?: string
  variant?: string
}

type V2SessionState = {
  routerName: string
  tier: Tier
  stateKey: string
  target: ModelTarget
}

function v2ModelKey(model: V2ModelSelection | undefined): string | null {
  if (!model?.providerID || !model.id) return null
  return modelKey(model.providerID, model.id)
}

function v2ModelRef(target: ModelTarget): { providerID: string; id: string; variant?: string } {
  return target.variant
    ? { providerID: target.providerID, id: target.modelID, variant: target.variant }
    : { providerID: target.providerID, id: target.modelID }
}

function v2TargetMatchesSelection(target: ModelTarget, selection: V2ModelSelection | undefined): boolean {
  return (
    targetKey(target) ===
    `${v2ModelKey(selection) ?? ""}#${selection?.variant ?? ""}`
  )
}

function buildV2Plugin(config: NormalizedPluginConfig, context: V2PluginContext) {
  const sessionTiers = new Map<string, Tier>()
  const sessionFirstMessage = new Map<string, boolean>()
  const sessionStates = new Map<string, V2SessionState>()
  const pendingAttempts = new Map<string, V2SessionState[]>()
  const failedTargets = new Map<string, Set<string>>()

  const selectTarget = (router: NormalizedRouter, tier: Tier, stateKey: string): ModelTarget => {
    const failed = failedTargets.get(stateKey)
    const target = targetsFor(router, tier).find((candidate) => !failed?.has(targetKey(candidate)))
    if (target) return target
    failed?.clear()
    return targetFor(router, tier)
  }

  const routePrompt = async (event: SessionHooks["prompt"]): Promise<void> => {
    if (!config.enabled) return

    const session = await context.session.get({ sessionID: event.sessionID })
    const selection = session.model
    const directRouter = findRouterForModel({
      config,
      providerID: selection?.providerID,
      modelID: selection?.id,
    })
    const previous = sessionStates.get(event.sessionID)
    const ownedModel = previous && v2TargetMatchesSelection(previous.target, selection)
    const router =
      directRouter ??
      (ownedModel ? config.routers.find((candidate) => candidate.name === previous.routerName) : undefined)
    if (!router || !selection) return
    if (!agentMatches(router, session.agent)) return

    const humanText = stripReminderBlocks(event.prompt.text)
    if (!humanText.trim()) return

    const sessionKey = `${router.name}:${event.sessionID}`
    if (router.firstMessageOnly) {
      const isFirst = sessionFirstMessage.get(sessionKey) !== true
      sessionFirstMessage.set(sessionKey, true)
      const previousTier = sessionTiers.get(sessionKey)
      const retryingFailedTarget =
        previousTier !== undefined && failedTargets.has(`${sessionKey}:${previousTier}`)
      if (!isFirst && !router.pinSession && !retryingFailedTarget) return
    }

    const pinned = router.pinSession ? sessionTiers.get(sessionKey) : undefined
    const result = pinned
      ? {
          tier: pinned,
          confidence: 1,
          cause: "session-pin",
          signals: [] as string[],
        }
      : await orchestrate(buildOrchestratorOptions(router), { prompt: humanText })
    const stateKey = `${sessionKey}:${result.tier}`
    const target = selectTarget(router, result.tier, stateKey)
    const alreadySelected = v2TargetMatchesSelection(target, selection)

    sessionStates.set(event.sessionID, {
      routerName: router.name,
      tier: result.tier,
      stateKey,
      target,
    })
    const attempts = pendingAttempts.get(event.sessionID) ?? []
    attempts.push({
      routerName: router.name,
      tier: result.tier,
      stateKey,
      target,
    })
    pendingAttempts.set(event.sessionID, attempts)
    sessionTiers.set(sessionKey, result.tier)

    if (!alreadySelected) {
      await context.session.switchModel({
        sessionID: event.sessionID,
        model: v2ModelRef(target),
      })
    }

    if (!alreadySelected && config.notify) {
      const label = router.tierLabels[result.tier] ?? result.tier
      const conf = result.confidence.toFixed(2)
      const targetRef = modelKey(target.providerID, target.modelID) ?? ""
      const targetLabel = target.variant ? `${targetRef} (${target.variant})` : targetRef
      console.log(
        `[auto-router] ${router.name}: ${label} (conf=${conf}, cause=${result.cause}) → ${targetLabel}`,
      )
    }
  }

  const observeSessionEvents = async (signal: AbortSignal): Promise<void> => {
    try {
      for await (const event of context.event.subscribe({ signal })) {
        if (event.type === "session.deleted") {
          const sessionID = event.data.sessionID
          sessionStates.delete(sessionID)
          pendingAttempts.delete(sessionID)
          for (const router of config.routers) {
            const sessionKey = `${router.name}:${sessionID}`
            sessionTiers.delete(sessionKey)
            sessionFirstMessage.delete(sessionKey)
            for (const stateKey of failedTargets.keys()) {
              if (stateKey.startsWith(`${sessionKey}:`)) failedTargets.delete(stateKey)
            }
          }
          continue
        }
        if (
          event.type !== "session.execution.failed" &&
          event.type !== "session.execution.succeeded" &&
          event.type !== "session.execution.interrupted"
        )
          continue
        const attempts = pendingAttempts.get(event.data.sessionID)
        const state = attempts?.shift()
        if (!state) continue
        if (attempts?.length === 0) pendingAttempts.delete(event.data.sessionID)
        if (
          event.type === "session.execution.failed" &&
          V2_NON_MODEL_ERROR_TYPES.has(event.data.error.type)
        )
          continue
        if (event.type === "session.execution.succeeded") {
          failedTargets.delete(state.stateKey)
          continue
        }
        if (event.type === "session.execution.interrupted") continue
        const failed = failedTargets.get(state.stateKey) ?? new Set<string>()
        failed.add(targetKey(state.target))
        failedTargets.set(state.stateKey, failed)
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error(
          `[auto-router] event observer stopped: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  return {
    setup: async (): Promise<() => Promise<void>> => {
      const registration = await context.session.hook("prompt", routePrompt)
      const controller = new AbortController()
      void observeSessionEvents(controller.signal)
      let cleanupPromise: Promise<void> | undefined
      return () => {
        if (!cleanupPromise) {
          const pending = (async () => {
            controller.abort()
            try {
              await registration.dispose()
            } finally {
              sessionTiers.clear()
              sessionFirstMessage.clear()
              sessionStates.clear()
              pendingAttempts.clear()
              failedTargets.clear()
            }
          })()
          cleanupPromise = pending
          void pending.catch(() => {
            if (cleanupPromise === pending) cleanupPromise = undefined
          })
        }
        return cleanupPromise
      }
    },
  }
}

export async function createAutoRouterV2WithConfig(
  config: NormalizedPluginConfig,
  context: V2PluginContext,
): Promise<() => Promise<void>> {
  return buildV2Plugin(config, context).setup()
}

const pluginModule = Plugin.define({
  id: "opencode-auto-router",
  setup: async (context: V2PluginContext) => {
    const config = normalizeConfig(loadConfig())
    return createAutoRouterV2WithConfig(config, context)
  },
})

export { resolveTierFromLabel, orchestrate, createHeuristicClassifier }
export type { OrchestratorOptions, OrchestratedResult, ClassifierFn, ClassifierVerdict }
export default pluginModule
