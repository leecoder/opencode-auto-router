import type { NormalizedConfig, RouterConfig, Tier } from "./config"

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

const CONFIG_FILENAMES = ["opencode-auto-router.json", "opencode-auto-router.jsonc"]

export function findConfigFile(): { path: string; raw: string } | null {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")

  const candidates = [
    path.join(process.cwd(), ".opencode", CONFIG_FILENAMES[0]),
    path.join(process.cwd(), ".opencode", CONFIG_FILENAMES[1]),
    path.join(process.cwd(), CONFIG_FILENAMES[0]),
    path.join(process.env.HOME ?? "~", ".config", "opencode", CONFIG_FILENAMES[0]),
    path.join(process.env.HOME ?? "~", ".config", "opencode", CONFIG_FILENAMES[1]),
    path.join(process.env.HOME ?? "~", ".opencode", CONFIG_FILENAMES[0]),
  ]

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { path: candidate, raw: fs.readFileSync(candidate, "utf-8") }
      }
    } catch {
      // keep scanning
    }
  }
  return null
}

export function parseConfigFile(raw: string, isJsonc: boolean): RouterConfig {
  const cleaned = isJsonc
    ? raw
        .replace(/(?<![:"\\])\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
    : raw
  return JSON.parse(cleaned) as RouterConfig
}

export function loadConfig(): RouterConfig | undefined {
  try {
    const found = findConfigFile()
    if (!found) return undefined
    const isJsonc = found.path.endsWith(".jsonc")
    return parseConfigFile(found.raw, isJsonc)
  } catch {
    return undefined
  }
}

export function extractText(parts: Array<{ type?: string; text?: string }>): string {
  return (
    parts
      ?.filter((part) => part.type === "text" && part.text)
      .map((part) => part.text as string)
      .join("\n")
      .trim() ?? ""
  )
}

export function tierLabel(config: NormalizedConfig, tier: Tier): string {
  return config.tierLabels[tier] ?? tier
}

export function modelRef(model: { providerID?: string; modelID?: string } | undefined): string | null {
  if (!model?.providerID || !model?.modelID) return null
  return `${model.providerID}/${model.modelID}`
}

export function splitModel(ref: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = ref.split("/")
  return { providerID: providerID!, modelID: rest.join("/") }
}

export function agentMatches(config: NormalizedConfig, agent?: string): boolean {
  if (!agent) return true
  if (config.excludeAgents?.some((name) => name.toLowerCase() === agent.toLowerCase())) return false
  if (config.agents && !config.agents.some((name) => name.toLowerCase() === agent.toLowerCase())) return false
  return true
}

export function extractSystemPrompt(output: ChatMessageOutput): string | undefined {
  // chat.message only carries the user message parts; the system prompt isn't
  // available here. LiteLLM scores code/technical over system+user, but the
  // system prompt is stable per deployment, so dropping it only shifts scores
  // by a constant. Reasoning markers are user-only by design in LiteLLM, so
  // the REASONING override path is unaffected.
  return undefined
}