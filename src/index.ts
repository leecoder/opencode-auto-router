/**
 * Auto Router — OpenCode plugin.
 *
 * Routes each user message to a model tier (SIMPLE / MEDIUM / COMPLEX /
 * REASONING) by classifying request complexity with the LiteLLM
 * complexity_router heuristic scorer, then rewriting `output.message.model`
 * in the `chat.message` hook — the same official extension point
 * oh-my-openagent's model-fallback uses.
 *
 * opencode keeps the full session, system prompt, tools, and agent context
 * intact; only the model that answers changes. A per-session tier cache
 * optionally pins the first decision for the session (LiteLLM's pinning).
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { normalizeConfig, type RouterConfig, type Tier } from "./config"
import { classifyRequest, stripReminderBlocks } from "./classifier"
import {
  agentMatches,
  extractSystemPrompt,
  extractText,
  loadConfig,
  modelRef,
  splitModel,
  type ChatMessageInput,
  type ChatMessageOutput,
} from "./helpers"

type PluginModule = {
  id: string
  server: (input: PluginInput) => Promise<Hooks>
}

export function createAutoRouter(): Hooks {
  const config = normalizeConfig(loadConfig())

  const sessionTiers = new Map<string, Tier>()
  const sessionFirstMessage = new Map<string, boolean>()

  const route = (input: ChatMessageInput, output: ChatMessageOutput): void => {
    const sessionID = input.sessionID ?? ""
    if (!config.enabled) return
    if (!agentMatches(config, input.agent)) return

    const promptText = extractText(output.parts)

    const currentModel = modelRef(input.model)
    if (!currentModel) return

    const humanText = stripReminderBlocks(promptText)
    if (!humanText.trim()) return

    if (config.pinSession) {
      const pinned = sessionTiers.get(sessionID)
      if (pinned) {
        const pinnedModel = config.tierModels[pinned]
        if (currentModel !== pinnedModel) {
          output.message.model = splitModel(pinnedModel)
        }
        return
      }
    }

    if (config.firstMessageOnly) {
      const isFirst = sessionFirstMessage.get(sessionID) !== true
      sessionFirstMessage.set(sessionID, true)
      if (!isFirst && !config.pinSession) return
    }

    const systemPrompt = extractSystemPrompt(output)
    const result = classifyRequest(
      {
        codeKeywords: config.codeKeywords,
        reasoningKeywords: config.reasoningKeywords,
        technicalKeywords: config.technicalKeywords,
        simpleKeywords: config.simpleKeywords,
        dimensionWeights: config.dimensionWeights,
        tierBoundaries: config.tierBoundaries,
        tokenThresholds: config.tokenThresholds,
      },
      humanText,
      systemPrompt,
    )

    const targetModel = config.tierModels[result.tier]
    if (!targetModel) return
    if (currentModel === targetModel) {
      sessionTiers.set(sessionID, result.tier)
      return
    }

    output.message.model = splitModel(targetModel)
    sessionTiers.set(sessionID, result.tier)

    if (config.notify) {
      const label = config.tierLabels[result.tier] ?? result.tier
      const score = result.score.toFixed(2)
      const signals = result.signals.slice(0, 3).join(" | ")
      console.log(
        `[auto-router] ${label} (score=${score}, cause=${result.cause}${signals ? `, ${signals}` : ""}) → ${targetModel}`,
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