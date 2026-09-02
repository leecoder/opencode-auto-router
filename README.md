# opencode-auto-router

Complexity-based auto router for [OpenCode](https://opencode.ai). Routes each user message to a SIMPLE / MEDIUM / COMPLEX / REASONING model tier by classifying request complexity — a faithful TypeScript port of LiteLLM's `complexity_router` heuristic scorer, applied locally via the `chat.message` hook.

```
User message → chat.message hook → complexity scoring → output.message.model = tier model
```

OpenCode keeps the full session, system prompt, tools, and agent context intact — only the model that answers changes.

## How it works

The classifier scores each request across 7 dimensions (LiteLLM defaults):

| Dimension | Weight |
|-----------|--------|
| tokenCount | 0.10 |
| codePresence | 0.30 |
| reasoningMarkers | 0.25 |
| technicalTerms | 0.25 |
| simpleIndicators | 0.05 |
| multiStepPatterns | 0.03 |
| questionComplexity | 0.02 |

The weighted score maps to tiers using configurable boundaries (defaults `0.15 / 0.35 / 0.60`). Two or more reasoning markers force the REASONING tier regardless of score (LiteLLM's reasoning override). Harness reminder blocks (`<system-reminder>…</system-reminder>`) are stripped before classification, and CJK/Hangul keywords match as plain substrings (word boundaries don't fire between CJK characters).

## Installation

```jsonc
// opencode.json (global or project)
{
  "plugin": ["opencode-auto-router"]
}
```

## Configuration

`~/.config/opencode/opencode-auto-router.json` (or `~/work/opencode-auto-router/opencode-auto-router.json`, `.opencode/opencode-auto-router.json`):

```json
{
  "tierModels": {
    "SIMPLE": "litellm/databricks/databricks-glm-5-3-flash",
    "MEDIUM": "litellm/databricks/databricks-deepseek-v4-flash-0731",
    "COMPLEX": "litellm/sonnet-5",
    "REASONING": "litellm/opus-5"
  },
  "defaultModel": "litellm/databricks/databricks-deepseek-v4-flash-0731",
  "pinSession": true,
  "notify": true,
  "enabled": true
}
```

| Option | Description |
|--------|-------------|
| `tierModels` | Tier → `provider/model-id` mapping (required) |
| `defaultModel` | Fallback when no tier can be determined |
| `codeKeywords` / `reasoningKeywords` / `technicalKeywords` / `simpleKeywords` | Keyword list overrides (defaults: LiteLLM's) |
| `dimensionWeights` | Scoring weight overrides |
| `tierBoundaries` | `simple_medium`, `medium_complex`, `complex_reasoning` |
| `tokenThresholds` | `simple` (short) / `complex` (long) token boundaries |
| `pinSession` | Pin the first session decision for the whole session (default `false`) |
| `firstMessageOnly` | Route only the first message of a session |
| `agents` / `excludeAgents` | Restrict routing to / exclude specific agents |
| `notify` | Log tier changes (default `true`) |

### Which model should you select in OpenCode?

**Any model — the router overrides it per message.** Select a *default* model that you're comfortable paying for on the first message of every session (the router's `chat.message` hook runs before the LLM call, so the selected model is only what the router *starts from*). Because the router decides per user message, the model you pick in the TUI is mostly irrelevant for routing purposes — it just needs to be an available model.

For best results:
- Pick a cheap-but-capable default (e.g. `litellm/gpt-5.6-luna` or the MEDIUM tier model) — SIMPLE-tier messages will be re-routed to cheap models anyway, and your default only matters if the router is disabled or misconfigured.
- With `pinSession: true`, the first message of each session fixes the tier for that session, so a cheap default means **every session starts SIMPLE/MEDIUM** until a complex ask arrives.

## Development

```bash
npm install
npx tsup          # build → dist/
npm test          # node --test test/*.test.mjs
```

## License

MIT