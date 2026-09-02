import type { NormalizedPluginConfig, NormalizedRouter, PluginConfig, RouterConfig, TierModels } from "./config"
import { DEFAULT_TIER_MODELS, DEFAULT_TRIGGER_MODELS, modelKey, normalizeConfig, normalizeRouter } from "./config"

export type {
  BoundaryName,
  DimensionName,
  NormalizedPluginConfig,
  NormalizedRouter,
  PluginConfig,
  RouterConfig,
  Tier,
  TierModels,
} from "./config"
export { DEFAULT_TIER_MODELS, DEFAULT_TRIGGER_MODELS, modelKey, normalizeConfig, normalizeRouter }

export interface FindRouterInput {
  config: NormalizedPluginConfig
  providerID?: string
  modelID?: string
}

/** First router whose triggerModels contain the session's selected model.
 *  Null when the selection matches no router — routing stays off for that
 *  turn and the picked model is used as-is. */
export function findRouterForModel(input: FindRouterInput): NormalizedRouter | null {
  const key = modelKey(input.providerID, input.modelID)
  if (!key) return null
  for (const router of input.config.routers) {
    if (router.triggerModels.includes(key)) return router
  }
  return null
}

const CONFIG_FILENAMES = ["opencode-auto-router.json", "opencode-auto-router.jsonc"]

export interface FoundConfigFile {
  path: string
  raw: string
}

export function findConfigFile(): FoundConfigFile | null {
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

export function parseConfigFile(raw: string, isJsonc: boolean): PluginConfig {
  const cleaned = isJsonc
    ? raw
        .replace(/(?<![:"\\])\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
    : raw
  return JSON.parse(cleaned) as PluginConfig
}

export function loadConfig(): PluginConfig | undefined {
  try {
    const found = findConfigFile()
    if (!found) return undefined
    const isJsonc = found.path.endsWith(".jsonc")
    return parseConfigFile(found.raw, isJsonc)
  } catch {
    return undefined
  }
}