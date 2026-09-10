/**
 * Configuration for the OpenCode Auto Router plugin.
 *
 * Mirrors LiteLLM's complexity_router_config shape so a YAML config from a
 * LiteLLM deployment can be carried over almost verbatim (keywords, weights,
 * boundaries) plus the model-per-tier mapping this plugin applies locally.
 *
 * Routing only fires when the session's selected model is `auto-router/{name}`
 * for one of the configured routers — picking any other model in the TUI
 * bypasses routing entirely, so a manually chosen model is always respected.
 */

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING"

/** Classifier backends and how they combine (see README "Classifiers") */
export type ClassifierKind = "heuristic" | "bert" | "apple-fm"
export type ClassifierCombination = "priority" | "vote"

/** Per-backend overrides inside `classifiers` */
export interface ClassifierConfig {
  /** Override the default model for this backend.
   *  bert: HF repo id or local path with onnx/ weights.
   *  apple-fm: reserved (no model selection on-device). */
  model?: string
  /** bert: ONNX file variant inside the repo (e.g. "model_quantized.onnx") */
  onnxFile?: string
  /** bert: map pipeline labels to tiers; missing labels → MEDIUM fallback */
  labelToTier?: Partial<Record<string, Tier>>
  /** Hard deadline per classify() call in ms (bert default 10000, apple-fm 15000) */
  timeoutMs?: number
  /** priority mode: below this confidence the backend is skipped (default 0.5) */
  minConfidence?: number
  /** priority mode: tiers that end evaluation immediately (default: SIMPLE, REASONING) */
  shortCircuitTiers?: Tier[]
  /** apple-fm: extra instructions prepended to the built-in classification prompt */
  instructions?: string
}

/** Optional per-tier variant (e.g. reasoningEffort) applied when routing to a
 *  tier model. Keyed by tier; models without variants omit the entry. */
export type TierVariants = Partial<Record<Tier, string>>
export interface TierModelSetting {
  model: string
  variant?: string
}
export type TierModelValue = string | TierModelSetting
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

export interface TierModels {
  SIMPLE: string
  MEDIUM: string
  COMPLEX: string
  REASONING: string
}

/** One named routing table. The model `auto-router/{name}` gates whether it
 * applies at all; any other selected model passes through untouched. */
export interface RouterConfig {
  /** Router name and the model id exposed as `auto-router/{name}`. */
  name?: string
  /** Tier → model reference or model plus variant. */
  tierModels?: Partial<Record<Tier, TierModelValue>>
  /** Tier → variant id (e.g. reasoningEffort) applied on top of tierModels.
   *  Only models that define `variants` in opencode.json accept them. */
  tierVariants?: Partial<Record<Tier, string>>
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
  /** Shorthand for `classifiers: ["heuristic"]` (default when omitted) */
  classifier?: ClassifierKind | ClassifierKind[]
  /** Classifier backends and their combination strategy. Default: heuristic-only. */
  classifiers?: ClassifierKind[]
  /** How multiple classifiers combine. Default: "priority" */
  classifierCombination?: ClassifierCombination
  /** Per-backend overrides keyed by kind (bert / apple-fm options) */
  classifierOptions?: Partial<Record<ClassifierKind, ClassifierConfig>>
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
  tierModels?: Partial<Record<Tier, TierModelValue>>
  tierVariants?: TierVariants
  defaultModel?: string
  tierLabels?: Partial<Record<Tier, string>>
  codeKeywords?: string[]
  reasoningKeywords?: string[]
  technicalKeywords?: string[]
  simpleKeywords?: string[]
  dimensionWeights?: Partial<Record<DimensionName, number>>
  tierBoundaries?: Partial<Record<BoundaryName, number>>
  tokenThresholds?: Partial<Record<"simple" | "complex", number>>
  classifier?: ClassifierKind | ClassifierKind[]
  classifiers?: ClassifierKind[]
  classifierCombination?: ClassifierCombination
  classifierOptions?: Partial<Record<ClassifierKind, ClassifierConfig>>
  pinSession?: boolean
  firstMessageOnly?: boolean
  agents?: string[]
  excludeAgents?: string[]
  /** Named routing tables. The first router whose `auto-router/{name}` model matches wins. */
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
  tierModels: TierModels
  tierVariants: TierVariants
  defaultModel: string
  tierLabels: Partial<Record<Tier, string>>
  codeKeywords: string[]
  reasoningKeywords: string[]
  technicalKeywords: string[]
  simpleKeywords: string[]
  dimensionWeights: Record<DimensionName, number>
  tierBoundaries: Record<BoundaryName, number>
  tokenThresholds: Record<"simple" | "complex", number>
  classifiers: ClassifierKind[]
  classifierCombination: ClassifierCombination
  classifierOptions: Partial<Record<ClassifierKind, ClassifierConfig>>
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

const KNOWN_CLASSIFIER_KINDS: readonly ClassifierKind[] = ["heuristic", "bert", "apple-fm"]

function normalizeClassifierKinds(
  shorthand: ClassifierKind | ClassifierKind[] | undefined,
  full: ClassifierKind[] | undefined,
): ClassifierKind[] {
  const raw = full ?? (shorthand !== undefined ? (Array.isArray(shorthand) ? shorthand : [shorthand]) : undefined)
  if (!raw || raw.length === 0) return ["heuristic"]
  const known = raw.filter((kind): kind is ClassifierKind => KNOWN_CLASSIFIER_KINDS.includes(kind))
  return known.length > 0 ? known : ["heuristic"]
}

export function normalizeRouter(raw: RouterConfig | undefined, index: number): NormalizedRouter {
  const tierModels = { ...FULL_TIER_DEFAULTS }
  const tierVariants = { ...(raw?.tierVariants ?? {}) }
  for (const tier of Object.keys(tierModels) as Tier[]) {
    const setting = raw?.tierModels?.[tier]
    if (!setting) continue
    if (typeof setting === "string") {
      tierModels[tier] = setting
      continue
    }
    tierModels[tier] = setting.model
    if (setting.variant !== undefined) tierVariants[tier] = setting.variant
  }
  return {
    name: raw?.name ?? `router-${index}`,
    tierModels,
    tierVariants,
    defaultModel: raw?.defaultModel ?? tierModels.MEDIUM,
    tierLabels: raw?.tierLabels ?? {},
    codeKeywords: raw?.codeKeywords ?? DEFAULT_CODE_KEYWORDS,
    reasoningKeywords: raw?.reasoningKeywords ?? DEFAULT_REASONING_KEYWORDS,
    technicalKeywords: raw?.technicalKeywords ?? DEFAULT_TECHNICAL_KEYWORDS,
    simpleKeywords: raw?.simpleKeywords ?? DEFAULT_SIMPLE_KEYWORDS,
    dimensionWeights: { ...DEFAULT_DIMENSION_WEIGHTS, ...raw?.dimensionWeights },
    tierBoundaries: { ...DEFAULT_TIER_BOUNDARIES, ...raw?.tierBoundaries },
    tokenThresholds: { ...DEFAULT_TOKEN_THRESHOLDS, ...raw?.tokenThresholds },
    classifiers: normalizeClassifierKinds(raw?.classifier, raw?.classifiers),
    classifierCombination: raw?.classifierCombination ?? "priority",
    classifierOptions: raw?.classifierOptions ?? {},
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
      raw?.tierVariants !== undefined ||
      raw?.codeKeywords !== undefined ||
      raw?.reasoningKeywords !== undefined ||
      raw?.technicalKeywords !== undefined ||
      raw?.simpleKeywords !== undefined)
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
