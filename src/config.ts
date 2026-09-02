/**
 * Configuration for the OpenCode Auto Router plugin.
 *
 * Mirrors LiteLLM's complexity_router_config shape so a YAML config from a
 * LiteLLM deployment can be carried over almost verbatim (keywords, weights,
 * boundaries) plus the model-per-tier mapping this plugin applies locally.
 */

export interface RouterConfig {
  /** Tier → model reference ("provider/model-id", e.g. "litellm/databricks/databricks-glm-5-3-flash") */
  tierModels: {
    SIMPLE: string
    MEDIUM: string
    COMPLEX: string
    REASONING: string
  }
  /** Fallback model when no tier can be determined (or when classifier errors) */
  defaultModel?: string
  /** Display names for tiers (optional; only used in toasts/logging) */
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
  /** Disable routing entirely (plugin becomes a no-op). Default: false */
  enabled?: boolean
  /** Show a toast when the tier changes. Default: true */
  notify?: boolean
  /** Only route messages where the agent is one of these. Empty = all agents. */
  agents?: string[]
  /** Never route messages where the agent is one of these. */
  excludeAgents?: string[]
  /** Route only the first message of a session (subsequent turns keep the first tier). Default: false */
  firstMessageOnly?: boolean
}

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

export const DEFAULT_TIER_MODELS: RouterConfig["tierModels"] = {
  SIMPLE: "litellm/databricks/databricks-glm-5-3-flash",
  MEDIUM: "litellm/databricks/databricks-deepseek-v4-flash-0731",
  COMPLEX: "litellm/sonnet-5",
  REASONING: "litellm/opus-5",
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

export interface NormalizedConfig {
  tierModels: RouterConfig["tierModels"]
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
  enabled: boolean
  notify: boolean
  agents: string[] | null
  excludeAgents: string[] | null
  firstMessageOnly: boolean
}

export function normalizeConfig(raw: RouterConfig | undefined): NormalizedConfig {
  return {
    tierModels: raw?.tierModels ?? DEFAULT_TIER_MODELS,
    defaultModel:
      raw?.defaultModel ?? raw?.tierModels?.MEDIUM ?? DEFAULT_TIER_MODELS.MEDIUM,
    tierLabels: raw?.tierLabels ?? {},
    codeKeywords: raw?.codeKeywords ?? DEFAULT_CODE_KEYWORDS,
    reasoningKeywords: raw?.reasoningKeywords ?? DEFAULT_REASONING_KEYWORDS,
    technicalKeywords: raw?.technicalKeywords ?? DEFAULT_TECHNICAL_KEYWORDS,
    simpleKeywords: raw?.simpleKeywords ?? DEFAULT_SIMPLE_KEYWORDS,
    dimensionWeights: { ...DEFAULT_DIMENSION_WEIGHTS, ...raw?.dimensionWeights },
    tierBoundaries: { ...DEFAULT_TIER_BOUNDARIES, ...raw?.tierBoundaries },
    tokenThresholds: { ...DEFAULT_TOKEN_THRESHOLDS, ...raw?.tokenThresholds },
    pinSession: raw?.pinSession ?? false,
    enabled: raw?.enabled ?? true,
    notify: raw?.notify ?? true,
    agents: raw?.agents && raw.agents.length > 0 ? raw.agents : null,
    excludeAgents: raw?.excludeAgents && raw.excludeAgents.length > 0 ? raw.excludeAgents : null,
    firstMessageOnly: raw?.firstMessageOnly ?? false,
  }
}