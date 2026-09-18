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
declare function stripReminderBlocks(text: string, markerPairs?: ReadonlyArray<readonly [string, string]>): string;
interface DimensionScore {
    name: string;
    score: number;
    signal: string | null;
}
type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
type ClassificationCause = "heuristic_scorer" | "reasoning_override";
interface ClassifierInput {
    codeKeywords: string[];
    reasoningKeywords: string[];
    technicalKeywords: string[];
    simpleKeywords: string[];
    dimensionWeights: Record<string, number>;
    tierBoundaries: Record<"simple_medium" | "medium_complex" | "complex_reasoning", number>;
    tokenThresholds: {
        simple: number;
        complex: number;
    };
}
interface ClassificationResult {
    tier: Tier;
    score: number;
    signals: string[];
    cause: ClassificationCause;
}
/** Port of ComplexityRouter._score_and_classify (heuristic scorer only — the LLM
 *  classifier path is intentionally not ported; we always run the local scorer). */
declare function classifyRequest(input: ClassifierInput, prompt: string, systemPrompt?: string): ClassificationResult;

export { type ClassificationCause, type ClassificationResult, type ClassifierInput, type DimensionScore, type Tier, classifyRequest, stripReminderBlocks };
