/**
 * Configuration for the OpenCode Auto Router plugin.
 *
 * Mirrors LiteLLM's complexity_router_config shape so a YAML config from a
 * LiteLLM deployment can be carried over almost verbatim (keywords, weights,
 * boundaries) plus the model-per-tier mapping this plugin applies locally.
 *
 * Routing only fires when the session's selected model matches one of a
 * router's `triggerModels` — picking any other model in the TUI bypasses
 * routing entirely, so a manually chosen model is always respected.
 */

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING"
export type DimensionName =
  | "tokenCount"
  | "codePresence"
  | "reasoningMarkers"
  | "technicalTerms"
  | "simpleIndicators"
  | "multiStepPatterns"
  | "questionComplexity"
export type BoundaryName = "simple_medium" | "medium_complex" | "complex_reasoning"

export const DEFAULT_TIER_MODELS: TierModels = {
  SIMPLE: "litellm/databricks/databricks-glm-5-3-flash",
  MEDIUM: "litellm/databricks/databricks-deepseek-v4-flash-0731",
  COMPLEX: "litellm/sonnet-5",
  REASONING: "litellm/opus-5",
}

export const DEFAULT_TRIGGER_MODELS = ["litellm/auto-dgc"]

export interface TierModels {
  SIMPLE: string
  MEDIUM: string
  COMPLEX: string
  REASONING: string
}

/** One named routing table. `triggerModels` gates whether it applies at all:
 *  when the session's selected model is one of them, tiers take over; any
 *  other selected model passes through untouched. */
export interface RouterConfig {
  /** Display name (used in logs) */
  name?: string
  /** Session models that activate this router. Default: ["litellm/auto-dgc"] */
  triggerModels?: string[]
  /** Tier → model reference ("provider/model-id") */
  tierModels?: Partial<TierModels>
  /** Fallback model when no tier can be determined (or when classifier errors) */
  defaultModel?: string
  /** Display names for tiers (optional; only used in logging) */
  tierLabels?: Partial<Record<Tier, string>>
  /** Keyword lists. When omitted, LiteLLM defaults are used. */
  codeKeywords?: string[]
  reasoningKeywords?: string[]
  technicalKeywords?: string[]
  simpleKeywords?: string[]
  /** Dimension weights. When omitted, LiteLLM defaults are used. */
  dimensionWeights?: Partial<Record<DimensionName, number>>
  /** Score boundaries between tiers. Defaults: simple_medium 0.15, medium_complex 0.35, complex_reasoning 0.60 */
  tierBoundaries?: Partial<Record<BoundaryName, number>>
  /** Token count thresholds. Defaults: simple 15, complex 400 */
  tokenThresholds?: Partial<Record<"simple" | "complex", number>>
  /** Session pinning: after the first request of a session picks a tier, keep that
   *  tier for subsequent turns of the same session. Default: false (route every turn) */
  pinSession?: boolean
  /** Route only the first message of a session (subsequent turns keep the first tier). Default: false */
  firstMessageOnly?: boolean
  /** Only route messages where the agent is one of these. Empty = all agents. */
  agents?: string[]
  /** Never route messages where the agent is one of these. */
  excludeAgents?: string[]
}

export interface PluginConfig {
  /** Master switch. Default: true */
  enabled?: boolean
  /** Log tier changes. Default: true */
  notify?: boolean
  /** Single-router shorthand — equivalent to one entry in `routers`. */
  triggerModels?: string[]
  tierModels?: Partial<TierModels>
  defaultModel?: string
  tierLabels?: Partial<Record<Tier, string>>
  codeKeywords?: string[]
  reasoningKeywords?: string[]
  technicalKeywords?: string[]
  simpleKeywords?: string[]
  dimensionWeights?: Partial<Record<DimensionName, number>>
  tierBoundaries?: Partial<Record<BoundaryName, number>>
  tokenThresholds?: Partial<Record<"simple" | "complex", number>>
  pinSession?: boolean
  firstMessageOnly?: boolean
  agents?: string[]
  excludeAgents?: string[]
  /** Named routing tables. First router whose triggerModels match wins. */
  routers?: RouterConfig[]
}

export const DEFAULT_CODE_KEYWORDS = [
  "function", "class", "def", "const", "let", "var", "import", "export", "return",
  "async", "await", "try", "catch", "exception", "error", "debug", "api", "endpoint",
  "request", "response", "database", "sql", "query", "schema", "algorithm", "implement",
  "refactor", "optimize", "python", "javascript", "typescript", "java", "rust", "golang",
  "react", "vue", "angular", "node", "docker", "kubernetes", "git", "commit", "merge",
  "branch", "pull request",
]

export const DEFAULT_REASONING_KEYWORDS = [
  "step by step", "think through", "let's think", "reason through", "analyze this",
  "break down", "explain your reasoning", "show your work", "chain of thought",
  "think carefully", "consider all", "evaluate", "pros and cons", "compare and contrast",
  "weigh the options", "logical", "deduce", "infer", "conclude",
]

export const DEFAULT_TECHNICAL_KEYWORDS = [
  "architecture", "distributed", "scalable", "microservice", "machine learning",
  "neural network", "deep learning", "encryption", "authentication", "authorization",
  "performance", "latency", "throughput", "benchmark", "concurrency", "parallel",
  "threading", "memory", "cpu", "gpu", "optimization", "protocol", "tcp", "http",
  "grpc", "websocket", "container", "orchestration",
]

export const DEFAULT_SIMPLE_KEYWORDS = [
  "what is", "what's", "define", "definition of", "who is", "who was", "when did",
  "when was", "where is", "where was", "how many", "how much", "yes or no",
  "true or false", "simple", "brief", "short", "quick", "hello", "hi", "hey",
  "thanks", "thank you", "goodbye", "bye", "okay",
]

export const DEFAULT_DIMENSION_WEIGHTS: Record<DimensionName, number> = {
  tokenCount: 0.1,
  codePresence: 0.3,
  reasoningMarkers: 0.25,
  technicalTerms: 0.25,
  simpleIndicators: 0.05,
  multiStepPatterns: 0.03,
  questionComplexity: 0.02,
}

export const DEFAULT_TIER_BOUNDARIES: Record<BoundaryName, number> = {
  simple_medium: 0.15,
  medium_complex: 0.35,
  complex_reasoning: 0.6,
}

export const DEFAULT_TOKEN_THRESHOLDS: Record<"simple" | "complex", number> = {
  simple: 15,
  complex: 400,
}

export interface NormalizedRouter {
  name: string
  triggerModels: string[]
  tierModels: TierModels
  defaultModel: string
  tierLabels: Partial<Record<Tier, string>>
  codeKeywords: string[]
  reasoningKeywords: string[]
  technicalKeywords: string[]
  simpleKeywords: string[]
  dimensionWeights: Record<DimensionName, number>
  tierBoundaries: Record<BoundaryName, number>
  tokenThresholds: Record<"simple" | "complex", number>
  pinSession: boolean
  firstMessageOnly: boolean
  agents: string[] | null
  excludeAgents: string[] | null
}

export interface NormalizedPluginConfig {
  enabled: boolean
  notify: boolean
  routers: NormalizedRouter[]
}

const FULL_TIER_DEFAULTS: TierModels = { ...DEFAULT_TIER_MODELS }

export function normalizeRouter(raw: RouterConfig | undefined, index: number): NormalizedRouter {
  const tierModels = { ...FULL_TIER_DEFAULTS, ...raw?.tierModels }
  return {
    name: raw?.name ?? `router-${index}`,
    triggerModels:
      raw?.triggerModels && raw.triggerModels.length > 0
        ? raw.triggerModels.map((m) => m.toLowerCase())
        : DEFAULT_TRIGGER_MODELS.map((m) => m.toLowerCase()),
    tierModels,
    defaultModel: raw?.defaultModel ?? tierModels.MEDIUM,
    tierLabels: raw?.tierLabels ?? {},
    codeKeywords: raw?.codeKeywords ?? DEFAULT_CODE_KEYWORDS,
    reasoningKeywords: raw?.reasoningKeywords ?? DEFAULT_REASONING_KEYWORDS,
    technicalKeywords: raw?.technicalKeywords ?? DEFAULT_TECHNICAL_KEYWORDS,
    simpleKeywords: raw?.simpleKeywords ?? DEFAULT_SIMPLE_KEYWORDS,
    dimensionWeights: { ...DEFAULT_DIMENSION_WEIGHTS, ...raw?.dimensionWeights },
    tierBoundaries: { ...DEFAULT_TIER_BOUNDARIES, ...raw?.tierBoundaries },
    tokenThresholds: { ...DEFAULT_TOKEN_THRESHOLDS, ...raw?.tokenThresholds },
    pinSession: raw?.pinSession ?? false,
    firstMessageOnly: raw?.firstMessageOnly ?? false,
    agents: raw?.agents && raw.agents.length > 0 ? raw.agents : null,
    excludeAgents: raw?.excludeAgents && raw.excludeAgents.length > 0 ? raw.excludeAgents : null,
  }
}

export function normalizeConfig(raw: PluginConfig | undefined): NormalizedPluginConfig {
  const routers: RouterConfig[] = []
  if (raw?.routers && raw.routers.length > 0) {
    routers.push(...raw.routers)
  }
  // Single-router shorthand: top-level tierModels/keywords fields form a router
  // only when `routers` is absent (a `routers` array always wins).
  const hasShorthand =
    !raw?.routers &&
    (raw?.tierModels !== undefined ||
      raw?.codeKeywords !== undefined ||
      raw?.reasoningKeywords !== undefined ||
      raw?.technicalKeywords !== undefined ||
      raw?.simpleKeywords !== undefined ||
      raw?.triggerModels !== undefined)
  if (hasShorthand) {
    const { enabled: _enabled, notify: _notify, routers: _routers, ...rest } = raw as PluginConfig & RouterConfig
    routers.push(rest)
  }
  if (routers.length === 0) {
    routers.push({})
  }

  return {
    enabled: raw?.enabled ?? true,
    notify: raw?.notify ?? true,
    routers: routers.map((router, index) => normalizeRouter(router, index)),
  }
}

/** Normalize a "provider/model" (or deeper, e.g. "litellm/databricks/x") into the
 *  canonical lowercase form used for trigger matching. */
export function modelKey(providerID?: string, modelID?: string): string | null {
  if (!providerID || !modelID) return null
  return `${providerID}/${modelID}`.toLowerCase()
}