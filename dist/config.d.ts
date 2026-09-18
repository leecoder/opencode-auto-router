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
type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
/** Classifier backends and how they combine (see README "Classifiers") */
type ClassifierKind = "heuristic" | "bert" | "apple-fm";
type ClassifierCombination = "priority" | "vote";
/** Per-backend overrides inside `classifiers` */
interface ClassifierConfig {
    /** Override the default model for this backend.
     *  bert: HF repo id or local path with onnx/ weights.
     *  apple-fm: reserved (no model selection on-device). */
    model?: string;
    /** bert: ONNX file variant inside the repo (e.g. "model_quantized.onnx") */
    onnxFile?: string;
    /** bert: map pipeline labels to tiers; missing labels → MEDIUM fallback */
    labelToTier?: Partial<Record<string, Tier>>;
    /** Hard deadline per classify() call in ms (bert default 10000, apple-fm 15000) */
    timeoutMs?: number;
    /** priority mode: below this confidence the backend is skipped (default 0.5) */
    minConfidence?: number;
    /** priority mode: tiers that end evaluation immediately (default: SIMPLE, REASONING) */
    shortCircuitTiers?: Tier[];
    /** apple-fm: extra instructions prepended to the built-in classification prompt */
    instructions?: string;
}
/** Optional per-tier variant (e.g. reasoningEffort) applied when routing to a
 *  tier model. Keyed by tier; models without variants omit the entry. */
type TierVariants = Partial<Record<Tier, string>>;
interface TierModelSetting {
    model: string;
    variant?: string;
}
type TierModelValue = string | TierModelSetting;
type DimensionName = "tokenCount" | "codePresence" | "reasoningMarkers" | "technicalTerms" | "simpleIndicators" | "multiStepPatterns" | "questionComplexity";
type BoundaryName = "simple_medium" | "medium_complex" | "complex_reasoning";
declare const DEFAULT_TIER_MODELS: TierModels;
interface TierModels {
    SIMPLE: string;
    MEDIUM: string;
    COMPLEX: string;
    REASONING: string;
}
/** One named routing table. The model `auto-router/{name}` gates whether it
 * applies at all; any other selected model passes through untouched. */
interface RouterConfig {
    /** Router name and the model id exposed as `auto-router/{name}`. */
    name?: string;
    /** Tier → model reference or model plus variant. */
    tierModels?: Partial<Record<Tier, TierModelValue>>;
    /** Tier → variant id (e.g. reasoningEffort) applied on top of tierModels.
     *  Only models that define `variants` in opencode.json accept them. */
    tierVariants?: Partial<Record<Tier, string>>;
    /** Fallback model when no tier can be determined (or when classifier errors) */
    defaultModel?: string;
    /** Display names for tiers (optional; only used in logging) */
    tierLabels?: Partial<Record<Tier, string>>;
    /** Keyword lists. When omitted, LiteLLM defaults are used. */
    codeKeywords?: string[];
    reasoningKeywords?: string[];
    technicalKeywords?: string[];
    simpleKeywords?: string[];
    /** Dimension weights. When omitted, LiteLLM defaults are used. */
    dimensionWeights?: Partial<Record<DimensionName, number>>;
    /** Score boundaries between tiers. Defaults: simple_medium 0.15, medium_complex 0.35, complex_reasoning 0.60 */
    tierBoundaries?: Partial<Record<BoundaryName, number>>;
    /** Token count thresholds. Defaults: simple 15, complex 400 */
    tokenThresholds?: Partial<Record<"simple" | "complex", number>>;
    /** Shorthand for `classifiers: ["heuristic"]` (default when omitted) */
    classifier?: ClassifierKind | ClassifierKind[];
    /** Classifier backends and their combination strategy. Default: heuristic-only. */
    classifiers?: ClassifierKind[];
    /** How multiple classifiers combine. Default: "priority" */
    classifierCombination?: ClassifierCombination;
    /** Per-backend overrides keyed by kind (bert / apple-fm options) */
    classifierOptions?: Partial<Record<ClassifierKind, ClassifierConfig>>;
    /** Session pinning: after the first request of a session picks a tier, keep that
     *  tier for subsequent turns of the same session. Default: false (route every turn) */
    pinSession?: boolean;
    /** Route only the first message of a session (subsequent turns keep the first tier). Default: false */
    firstMessageOnly?: boolean;
    /** Only route messages where the agent is one of these. Empty = all agents. */
    agents?: string[];
    /** Never route messages where the agent is one of these. */
    excludeAgents?: string[];
}
interface PluginConfig {
    /** Master switch. Default: true */
    enabled?: boolean;
    /** Log tier changes. Default: true */
    notify?: boolean;
    /** Single-router shorthand — equivalent to one entry in `routers`. */
    tierModels?: Partial<Record<Tier, TierModelValue>>;
    tierVariants?: TierVariants;
    defaultModel?: string;
    tierLabels?: Partial<Record<Tier, string>>;
    codeKeywords?: string[];
    reasoningKeywords?: string[];
    technicalKeywords?: string[];
    simpleKeywords?: string[];
    dimensionWeights?: Partial<Record<DimensionName, number>>;
    tierBoundaries?: Partial<Record<BoundaryName, number>>;
    tokenThresholds?: Partial<Record<"simple" | "complex", number>>;
    classifier?: ClassifierKind | ClassifierKind[];
    classifiers?: ClassifierKind[];
    classifierCombination?: ClassifierCombination;
    classifierOptions?: Partial<Record<ClassifierKind, ClassifierConfig>>;
    pinSession?: boolean;
    firstMessageOnly?: boolean;
    agents?: string[];
    excludeAgents?: string[];
    /** Named routing tables. The first router whose `auto-router/{name}` model matches wins. */
    routers?: RouterConfig[];
}
declare const DEFAULT_CODE_KEYWORDS: string[];
declare const DEFAULT_REASONING_KEYWORDS: string[];
declare const DEFAULT_TECHNICAL_KEYWORDS: string[];
declare const DEFAULT_SIMPLE_KEYWORDS: string[];
declare const DEFAULT_DIMENSION_WEIGHTS: Record<DimensionName, number>;
declare const DEFAULT_TIER_BOUNDARIES: Record<BoundaryName, number>;
declare const DEFAULT_TOKEN_THRESHOLDS: Record<"simple" | "complex", number>;
interface NormalizedRouter {
    name: string;
    tierModels: TierModels;
    tierVariants: TierVariants;
    defaultModel: string;
    tierLabels: Partial<Record<Tier, string>>;
    codeKeywords: string[];
    reasoningKeywords: string[];
    technicalKeywords: string[];
    simpleKeywords: string[];
    dimensionWeights: Record<DimensionName, number>;
    tierBoundaries: Record<BoundaryName, number>;
    tokenThresholds: Record<"simple" | "complex", number>;
    classifiers: ClassifierKind[];
    classifierCombination: ClassifierCombination;
    classifierOptions: Partial<Record<ClassifierKind, ClassifierConfig>>;
    pinSession: boolean;
    firstMessageOnly: boolean;
    agents: string[] | null;
    excludeAgents: string[] | null;
}
interface NormalizedPluginConfig {
    enabled: boolean;
    notify: boolean;
    routers: NormalizedRouter[];
}
declare function normalizeRouter(raw: RouterConfig | undefined, index: number): NormalizedRouter;
declare function normalizeConfig(raw: PluginConfig | undefined): NormalizedPluginConfig;
/** Normalize a "provider/model" (or deeper, e.g. "litellm/databricks/x") into the
 *  canonical lowercase form used for trigger matching. */
declare function modelKey(providerID?: string, modelID?: string): string | null;

export { type BoundaryName, type ClassifierCombination, type ClassifierConfig, type ClassifierKind, DEFAULT_CODE_KEYWORDS, DEFAULT_DIMENSION_WEIGHTS, DEFAULT_REASONING_KEYWORDS, DEFAULT_SIMPLE_KEYWORDS, DEFAULT_TECHNICAL_KEYWORDS, DEFAULT_TIER_BOUNDARIES, DEFAULT_TIER_MODELS, DEFAULT_TOKEN_THRESHOLDS, type DimensionName, type NormalizedPluginConfig, type NormalizedRouter, type PluginConfig, type RouterConfig, type Tier, type TierModelSetting, type TierModelValue, type TierModels, type TierVariants, modelKey, normalizeConfig, normalizeRouter };
