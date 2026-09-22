// src/config.ts
var DEFAULT_TIER_MODELS = {
  SIMPLE: "litellm/databricks/databricks-glm-5-3-flash",
  MEDIUM: "litellm/databricks/databricks-deepseek-v4-flash-0731",
  COMPLEX: "litellm/sonnet-5",
  REASONING: "litellm/opus-5"
};
var DEFAULT_CODE_KEYWORDS = [
  "function",
  "class",
  "def",
  "const",
  "let",
  "var",
  "import",
  "export",
  "return",
  "async",
  "await",
  "try",
  "catch",
  "exception",
  "error",
  "debug",
  "api",
  "endpoint",
  "request",
  "response",
  "database",
  "sql",
  "query",
  "schema",
  "algorithm",
  "implement",
  "refactor",
  "optimize",
  "python",
  "javascript",
  "typescript",
  "java",
  "rust",
  "golang",
  "react",
  "vue",
  "angular",
  "node",
  "docker",
  "kubernetes",
  "git",
  "commit",
  "merge",
  "branch",
  "pull request"
];
var DEFAULT_REASONING_KEYWORDS = [
  "step by step",
  "think through",
  "let's think",
  "reason through",
  "analyze this",
  "break down",
  "explain your reasoning",
  "show your work",
  "chain of thought",
  "think carefully",
  "consider all",
  "evaluate",
  "pros and cons",
  "compare and contrast",
  "weigh the options",
  "logical",
  "deduce",
  "infer",
  "conclude"
];
var DEFAULT_TECHNICAL_KEYWORDS = [
  "architecture",
  "distributed",
  "scalable",
  "microservice",
  "machine learning",
  "neural network",
  "deep learning",
  "encryption",
  "authentication",
  "authorization",
  "performance",
  "latency",
  "throughput",
  "benchmark",
  "concurrency",
  "parallel",
  "threading",
  "memory",
  "cpu",
  "gpu",
  "optimization",
  "protocol",
  "tcp",
  "http",
  "grpc",
  "websocket",
  "container",
  "orchestration"
];
var DEFAULT_SIMPLE_KEYWORDS = [
  "what is",
  "what's",
  "define",
  "definition of",
  "who is",
  "who was",
  "when did",
  "when was",
  "where is",
  "where was",
  "how many",
  "how much",
  "yes or no",
  "true or false",
  "simple",
  "brief",
  "short",
  "quick",
  "hello",
  "hi",
  "hey",
  "thanks",
  "thank you",
  "goodbye",
  "bye",
  "okay"
];
var DEFAULT_DIMENSION_WEIGHTS = {
  tokenCount: 0.1,
  codePresence: 0.3,
  reasoningMarkers: 0.25,
  technicalTerms: 0.25,
  simpleIndicators: 0.05,
  multiStepPatterns: 0.03,
  questionComplexity: 0.02
};
var DEFAULT_TIER_BOUNDARIES = {
  simple_medium: 0.15,
  medium_complex: 0.35,
  complex_reasoning: 0.6
};
var DEFAULT_TOKEN_THRESHOLDS = {
  simple: 15,
  complex: 400
};
var FULL_TIER_DEFAULTS = { ...DEFAULT_TIER_MODELS };
var KNOWN_CLASSIFIER_KINDS = ["heuristic", "bert", "apple-fm"];
function normalizeClassifierKinds(shorthand, full) {
  const raw = full ?? (shorthand !== void 0 ? Array.isArray(shorthand) ? shorthand : [shorthand] : void 0);
  if (!raw || raw.length === 0) return ["heuristic"];
  const known = raw.filter((kind) => KNOWN_CLASSIFIER_KINDS.includes(kind));
  return known.length > 0 ? known : ["heuristic"];
}
function normalizeRouter(raw, index) {
  const tierModels = { ...FULL_TIER_DEFAULTS };
  const tierFallbacks = {};
  const tierVariants = { ...raw?.tierVariants ?? {} };
  for (const tier of Object.keys(tierModels)) {
    const setting = raw?.tierModels?.[tier];
    if (!setting) continue;
    if (typeof setting === "string") {
      tierModels[tier] = setting;
      continue;
    }
    tierModels[tier] = setting.model;
    if (setting.fallbacks !== void 0) tierFallbacks[tier] = setting.fallbacks;
    if (setting.variant !== void 0) tierVariants[tier] = setting.variant;
  }
  return {
    name: raw?.name ?? `router-${index}`,
    tierModels,
    tierFallbacks,
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
    excludeAgents: raw?.excludeAgents && raw.excludeAgents.length > 0 ? raw.excludeAgents : null
  };
}
function normalizeConfig(raw) {
  const routers = [];
  if (raw?.routers && raw.routers.length > 0) {
    routers.push(...raw.routers);
  }
  const hasShorthand = !raw?.routers && (raw?.tierModels !== void 0 || raw?.tierVariants !== void 0 || raw?.codeKeywords !== void 0 || raw?.reasoningKeywords !== void 0 || raw?.technicalKeywords !== void 0 || raw?.simpleKeywords !== void 0);
  if (hasShorthand) {
    const { enabled: _enabled, notify: _notify, routers: _routers, ...rest } = raw;
    routers.push(rest);
  }
  if (routers.length === 0) {
    routers.push({});
  }
  return {
    enabled: raw?.enabled ?? true,
    notify: raw?.notify ?? true,
    routers: routers.map((router, index) => normalizeRouter(router, index))
  };
}
function modelKey(providerID, modelID) {
  if (!providerID || !modelID) return null;
  return `${providerID}/${modelID}`.toLowerCase();
}

export {
  DEFAULT_TIER_MODELS,
  DEFAULT_CODE_KEYWORDS,
  DEFAULT_REASONING_KEYWORDS,
  DEFAULT_TECHNICAL_KEYWORDS,
  DEFAULT_SIMPLE_KEYWORDS,
  DEFAULT_DIMENSION_WEIGHTS,
  DEFAULT_TIER_BOUNDARIES,
  DEFAULT_TOKEN_THRESHOLDS,
  normalizeRouter,
  normalizeConfig,
  modelKey
};
