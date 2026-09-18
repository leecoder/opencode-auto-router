// src/classifier.ts
var DEFAULT_REMINDER_MARKER_PAIRS = [
  ["<system-reminder>", "</system-reminder>"]
];
function reminderBlockSpans(lowered, openMarker, closeMarker) {
  const spans = [];
  let cursor = 0;
  while (true) {
    const start = lowered.indexOf(openMarker, cursor);
    if (start === -1) return spans;
    const end = lowered.indexOf(closeMarker, start + openMarker.length);
    if (end === -1) return spans;
    cursor = end + closeMarker.length;
    spans.push([start, cursor]);
  }
}
function stripReminderBlocks(text, markerPairs = DEFAULT_REMINDER_MARKER_PAIRS) {
  const lowered = text.toLowerCase();
  const spans = markerPairs.flatMap(([open, close]) => reminderBlockSpans(lowered, open, close)).sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return text.trim();
  const keepFrom = [0];
  const keepTo = [];
  let maxEnd = 0;
  for (const [start, end] of spans) {
    keepTo.push(start);
    maxEnd = Math.max(maxEnd, end);
    keepFrom.push(maxEnd);
  }
  keepTo.push(text.length);
  return keepFrom.map((from, i) => text.slice(from, keepTo[i]).trim()).filter(Boolean).join(" ");
}
var CJK_CHARACTER = /[\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9D\u{20000}-\u{3FFFF}]/u;
var HANGUL_CHARACTER = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF]/;
function isNoBoundaryKeyword(keyword) {
  return keyword.includes(" ") || CJK_CHARACTER.test(keyword) || HANGUL_CHARACTER.test(keyword);
}
function keywordMatches(text, keyword) {
  const kwLower = keyword.toLowerCase();
  if (isNoBoundaryKeyword(kwLower)) {
    return text.includes(kwLower);
  }
  return new RegExp(`\\b${escapeRegExp(kwLower)}\\b`).test(text);
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var MULTI_STEP_PATTERNS = [
  /first.*?then/i,
  /step\s*\d/i,
  /\d+\.\s/,
  /[a-z]\)\s/i
];
function scoreTokenCount(estimatedTokens, thresholds) {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}
function scoreKeywordMatch(text, disclosableText, keywords, name, signalLabel, thresholds, scores) {
  const [lowThreshold, highThreshold] = thresholds;
  const [scoreNone, scoreLow, scoreHigh] = scores;
  const matches = keywords.filter((kw) => keywordMatches(text, kw));
  const matchCount = matches.length;
  if (matchCount < lowThreshold) {
    return { dimension: { name, score: scoreNone, signal: null }, matchCount };
  }
  const disclosable = matches.filter((kw) => keywordMatches(disclosableText, kw));
  const detail = disclosable.length > 0 ? disclosable.slice(0, 3).join(", ") : `${matchCount} matches`;
  const score = matchCount >= highThreshold ? scoreHigh : scoreLow;
  return { dimension: { name, score, signal: `${signalLabel} (${detail})` }, matchCount };
}
function scoreMultiStep(text) {
  const hits = MULTI_STEP_PATTERNS.filter((pattern) => pattern.test(text)).length;
  if (hits > 0) return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" };
  return { name: "multiStepPatterns", score: 0, signal: null };
}
function scoreQuestionComplexity(text) {
  const count = text.split("?").length - 1;
  if (count > 3) return { name: "questionComplexity", score: 0.5, signal: `${count} questions` };
  return { name: "questionComplexity", score: 0, signal: null };
}
function classifyRequest(input, prompt, systemPrompt) {
  const fullText = `${systemPrompt ?? ""} ${prompt}`.toLowerCase();
  const userText = prompt.toLowerCase();
  const estimatedTokens = Math.floor(prompt.length / 4);
  const code = scoreKeywordMatch(fullText, userText, input.codeKeywords, "codePresence", "code", [1, 2], [0, 0.5, 1]);
  const reasoning = scoreKeywordMatch(userText, userText, input.reasoningKeywords, "reasoningMarkers", "reasoning", [1, 2], [0, 0.7, 1]);
  const technical = scoreKeywordMatch(fullText, userText, input.technicalKeywords, "technicalTerms", "technical", [2, 4], [0, 0.5, 1]);
  const simple = scoreKeywordMatch(fullText, userText, input.simpleKeywords, "simpleIndicators", "simple", [1, 2], [0, -1, -1]);
  const dimensions = [
    scoreTokenCount(estimatedTokens, input.tokenThresholds),
    code.dimension,
    reasoning.dimension,
    technical.dimension,
    simple.dimension,
    scoreMultiStep(fullText),
    scoreQuestionComplexity(prompt)
  ];
  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal);
  const weight = input.dimensionWeights;
  const weightedScore = dimensions.reduce((sum, d) => sum + d.score * (weight[d.name] ?? 0), 0);
  if (reasoning.matchCount >= 2) {
    return { tier: "REASONING", score: weightedScore, signals, cause: "reasoning_override" };
  }
  const boundaries = input.tierBoundaries;
  let tier;
  if (weightedScore < boundaries.simple_medium) tier = "SIMPLE";
  else if (weightedScore < boundaries.medium_complex) tier = "MEDIUM";
  else if (weightedScore < boundaries.complex_reasoning) tier = "COMPLEX";
  else tier = "REASONING";
  return { tier, score: weightedScore, signals, cause: "heuristic_scorer" };
}

export {
  stripReminderBlocks,
  classifyRequest
};
