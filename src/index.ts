import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { normalizeConfig, type Tier } from "./config"
import { findRouterForModel, loadConfig, modelKey } from "./config-loader"
import { classifyRequest, stripReminderBlocks } from "./classifier"

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
  message: Record<string, unknown> & { model?: { providerID: string; modelID: string } }
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

function agentMatches(router: ReturnType<typeof normalizeConfig>["routers"][number], agent?: string): boolean {
  if (!agent) return true
  if (router.excludeAgents?.some((name) => name.toLowerCase() === agent.toLowerCase())) return false
  if (router.agents && !router.agents.some((name) => name.toLowerCase() === agent.toLowerCase())) return false
  return true
}

export function createAutoRouter(): Hooks {
  const config = normalizeConfig(loadConfig())

  // Per-router session state, keyed by `${routerName}:${sessionID}` so multiple
  // routers can coexist without one pin bleeding into another.
  const sessionTiers = new Map<string, Tier>()
  const sessionFirstMessage = new Map<string, boolean>()

  const route = (input: ChatMessageInput, output: ChatMessageOutput): void => {
    if (!config.enabled) return

    // Gate 1: the session's selected model must match a router's triggerModels.
    // Any other selection passes through untouched — manual model choice wins.
    const router = findRouterForModel({
      config,
      providerID: input.model?.providerID,
      modelID: input.model?.modelID,
    })
    if (!router) return
    if (!agentMatches(router, input.agent)) return

    const sessionID = input.sessionID ?? ""
    const stateKey = `${router.name}:${sessionID}`

    const promptText = extractText(output.parts)
    const humanText = stripReminderBlocks(promptText)
    if (!humanText.trim()) return

    const selectedRef = modelKey(input.model?.providerID, input.model?.modelID) ?? ""

    if (router.pinSession) {
      const pinned = sessionTiers.get(stateKey)
      if (pinned) {
        const pinnedModel = router.tierModels[pinned]
        if (selectedRef !== pinnedModel.toLowerCase()) {
          output.message.model = splitModel(pinnedModel)
        }
        return
      }
    }

    if (router.firstMessageOnly) {
      const isFirst = sessionFirstMessage.get(stateKey) !== true
      sessionFirstMessage.set(stateKey, true)
      if (!isFirst && !router.pinSession) return
    }

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
      humanText,
      undefined,
    )

    const targetModel = router.tierModels[result.tier]
    if (!targetModel) return
    if (selectedRef === targetModel.toLowerCase()) {
      sessionTiers.set(stateKey, result.tier)
      return
    }

    output.message.model = splitModel(targetModel)
    sessionTiers.set(stateKey, result.tier)

    if (config.notify) {
      const label = router.tierLabels[result.tier] ?? result.tier
      const score = result.score.toFixed(2)
      const signals = result.signals.slice(0, 3).join(" | ")
      console.log(
        `[auto-router] ${router.name}: ${label} (score=${score}, cause=${result.cause}${signals ? `, ${signals}` : ""}) → ${targetModel}`,
      )
    }
  }

  return {
    "chat.message": async (input: unknown, output: unknown) => {
      route(input as ChatMessageInput, output as ChatMessageOutput)
    },
  }
}

const pluginModule: PluginModule = {
  id: "opencode-auto-router",
  server: async () => createAutoRouter(),
}

export default pluginModule