/**
 * Complexity classifier — a faithful TypeScript port of LiteLLM's
 * `ComplexityRouter._score_and_classify` heuristic scorer and its helpers.
 *
 * Scoring reads:
 * - tokenCount (short → simple, long → complex)
 * - codePresence (code keywords)
 * - reasoningMarkers (explicit reasoning asks; 2+ markers force REASONING tier)
 * - technicalTerms
 * - simpleIndicators (negative weight)
 * - multiStepPatterns
 * - questionComplexity
 *
 * Harness reminder blocks (<system-reminder>…) are stripped before classification,
 * and CJK keywords match as plain substrings (word boundaries don't fire between
 * CJK characters in every script the prompts are written in).
 */

// --- Reminder block stripping (port of _reminder_block_spans / _strip_reminder_blocks) ---

const DEFAULT_REMINDER_MARKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["<system-reminder>", "</system-reminder>"],
]

function reminderBlockSpans(lowered: string, openMarker: string, closeMarker: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let cursor = 0
  while (true) {
    const start = lowered.indexOf(openMarker, cursor)
    if (start === -1) return spans
    const end = lowered.indexOf(closeMarker, start + openMarker.length)
    if (end === -1) return spans
    cursor = end + closeMarker.length
    spans.push([start, cursor])
  }
}

export function stripReminderBlocks(
  text: string,
  markerPairs: ReadonlyArray<readonly [string, string]> = DEFAULT_REMINDER_MARKER_PAIRS,
): string {
  const lowered = text.toLowerCase()
  const spans = markerPairs
    .flatMap(([open, close]) => reminderBlockSpans(lowered, open, close))
    .sort((a, b) => a[0] - b[0])
  if (spans.length === 0) return text.trim()

  // Gaps between spans (collapsing nested/overlapping blocks via running max end)
  const keepFrom: number[] = [0]
  const keepTo: number[] = []
  let maxEnd = 0
  for (const [start, end] of spans) {
    keepTo.push(start)
    maxEnd = Math.max(maxEnd, end)
    keepFrom.push(maxEnd)
  }
  keepTo.push(text.length)

  return keepFrom
    .map((from, i) => text.slice(from, keepTo[i]!).trim())
    .filter(Boolean)
    .join(" ")
}

// --- CJK detection (port of _CJK_CHARACTER, extended to Hangul: LiteLLM's regex
//     misses U+AC00–U+D7AF where Korean syllables live) ---

const CJK_CHARACTER = /[\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9D\u{20000}-\u{3FFFF}]/u
const HANGUL_CHARACTER = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF]/

// --- Keyword matching (port of _keyword_matches) ---

function isNoBoundaryKeyword(keyword: string): boolean {
  return keyword.includes(" ") || CJK_CHARACTER.test(keyword) || HANGUL_CHARACTER.test(keyword)
}

function keywordMatches(text: string, keyword: string): boolean {
  const kwLower = keyword.toLowerCase()
  if (isNoBoundaryKeyword(kwLower)) {
    return text.includes(kwLower)
  }
  // Single-word keywords: word-boundary match to avoid "api" ⊂ "capital" etc.
  return new RegExp(`\\b${escapeRegExp(kwLower)}\\b`).test(text)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// --- Multi-step patterns (port of _multi_step_patterns) ---

const MULTI_STEP_PATTERNS: RegExp[] = [
  /first.*?then/i,
  /step\s*\d/i,
  /\d+\.\s/,
  /[a-z]\)\s/i,
]

// --- Dimension scoring (ports of DimensionScore, _score_token_count,
//     _score_keyword_match, _score_multi_step, _score_question_complexity) ---

export interface DimensionScore {
  name: string
  score: number
  signal: string | null
}

function scoreTokenCount(estimatedTokens: number, thresholds: { simple: number; complex: number }): DimensionScore {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1, signal: `short (${estimatedTokens} tokens)` }
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1, signal: `long (${estimatedTokens} tokens)` }
  }
  return { name: "tokenCount", score: 0, signal: null }
}

interface KeywordMatchOutcome {
  dimension: DimensionScore
  matchCount: number
}

function scoreKeywordMatch(
  text: string,
  disclosableText: string,
  keywords: string[],
  name: string,
  signalLabel: string,
  thresholds: readonly [number, number], // (low, high)
  scores: readonly [number, number, number], // (none, low, high)
): KeywordMatchOutcome {
  const [lowThreshold, highThreshold] = thresholds
  const [scoreNone, scoreLow, scoreHigh] = scores

  const matches = keywords.filter((kw) => keywordMatches(text, kw))
  const matchCount = matches.length

  if (matchCount < lowThreshold) {
    return { dimension: { name, score: scoreNone, signal: null }, matchCount }
  }

  // Only disclose keywords that also appear in the caller's own message
  // (never leak configured keywords merely present in the system prompt).
  const disclosable = matches.filter((kw) => keywordMatches(disclosableText, kw))
  const detail = disclosable.length > 0 ? disclosable.slice(0, 3).join(", ") : `${matchCount} matches`
  const score = matchCount >= highThreshold ? scoreHigh : scoreLow
  return { dimension: { name, score, signal: `${signalLabel} (${detail})` }, matchCount }
}

function scoreMultiStep(text: string): DimensionScore {
  const hits = MULTI_STEP_PATTERNS.filter((pattern) => pattern.test(text)).length
  if (hits > 0) return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" }
  return { name: "multiStepPatterns", score: 0, signal: null }
}

function scoreQuestionComplexity(text: string): DimensionScore {
  const count = text.split("?").length - 1
  if (count > 3) return { name: "questionComplexity", score: 0.5, signal: `${count} questions` }
  return { name: "questionComplexity", score: 0, signal: null }
}

// --- Classification (port of classify + _score_and_classify) ---

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING"

export type ClassificationCause = "heuristic_scorer" | "reasoning_override"

export interface ClassifierInput {
  codeKeywords: string[]
  reasoningKeywords: string[]
  technicalKeywords: string[]
  simpleKeywords: string[]
  dimensionWeights: Record<string, number>
  tierBoundaries: Record<"simple_medium" | "medium_complex" | "complex_reasoning", number>
  tokenThresholds: { simple: number; complex: number }
}

export interface ClassificationResult {
  tier: Tier
  score: number
  signals: string[]
  cause: ClassificationCause
}

/** Port of ComplexityRouter._score_and_classify (heuristic scorer only — the LLM
 *  classifier path is intentionally not ported; we always run the local scorer). */
export function classifyRequest(input: ClassifierInput, prompt: string, systemPrompt?: string): ClassificationResult {
  const fullText = `${systemPrompt ?? ""} ${prompt}`.toLowerCase()
  const userText = prompt.toLowerCase()
  const estimatedTokens = Math.floor(prompt.length / 4)

  const code = scoreKeywordMatch(fullText, userText, input.codeKeywords, "codePresence", "code", [1, 2], [0, 0.5, 1])
  const reasoning = scoreKeywordMatch(userText, userText, input.reasoningKeywords, "reasoningMarkers", "reasoning", [1, 2], [0, 0.7, 1])
  const technical = scoreKeywordMatch(fullText, userText, input.technicalKeywords, "technicalTerms", "technical", [2, 4], [0, 0.5, 1])
  const simple = scoreKeywordMatch(fullText, userText, input.simpleKeywords, "simpleIndicators", "simple", [1, 2], [0, -1, -1])

  const dimensions: DimensionScore[] = [
    scoreTokenCount(estimatedTokens, input.tokenThresholds),
    code.dimension,
    reasoning.dimension,
    technical.dimension,
    simple.dimension,
    scoreMultiStep(fullText),
    scoreQuestionComplexity(prompt),
  ]

  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal as string)

  const weight = input.dimensionWeights
  const weightedScore = dimensions.reduce((sum, d) => sum + d.score * (weight[d.name] ?? 0), 0)

  if (reasoning.matchCount >= 2) {
    return { tier: "REASONING", score: weightedScore, signals, cause: "reasoning_override" }
  }

  const boundaries = input.tierBoundaries
  let tier: Tier
  if (weightedScore < boundaries.simple_medium) tier = "SIMPLE"
  else if (weightedScore < boundaries.medium_complex) tier = "MEDIUM"
  else if (weightedScore < boundaries.complex_reasoning) tier = "COMPLEX"
  else tier = "REASONING"

  return { tier, score: weightedScore, signals, cause: "heuristic_scorer" }
}