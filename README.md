# opencode-auto-router

Complexity-based auto router for [OpenCode](https://opencode.ai). Works like a fusion-style **local model**: register `auto-router/{name}` in `opencode.json`, and selecting it in the TUI activates per-message tier routing (SIMPLE / MEDIUM / COMPLEX / REASONING). Any other model selection — including real gateway models — is used exactly as picked. Applied via the `chat.message` hook.

Classification is pluggable: a LiteLLM-ported heuristic scorer (default), a local BERT-style ONNX model, or the macOS on-device Apple Foundation Model — usable alone or combined (priority chain / confidence vote).

```
TUI selection ─┬─ auto-router/{name} (local router model)
               │      └→ chat.message hook → complexity scoring → tier model
               └─ any other model → used as-is (routing skipped)
```

OpenCode keeps the full session, system prompt, tools, and agent context intact — only the model that answers changes.

## How it works

1. **Trigger gate**: the session's selected model is checked against `auto-router/{name}` for each router. No match → the plugin does nothing for that message.
2. **Classification**: the router's classifier backends produce a tier. Default is the heuristic scorer, which rates the request across 7 dimensions (LiteLLM defaults):

| Dimension | Weight |
|-----------|--------|
| tokenCount | 0.10 |
| codePresence | 0.30 |
| reasoningMarkers | 0.25 |
| technicalTerms | 0.25 |
| simpleIndicators | 0.05 |
| multiStepPatterns | 0.03 |
| questionComplexity | 0.02 |

3. **Tier mapping**: the weighted score maps to tiers via boundaries (defaults `0.15 / 0.35 / 0.60`). Two or more reasoning markers force the REASONING tier regardless of score (LiteLLM's reasoning override). Harness reminder blocks (`<system-reminder>…</system-reminder>`) are stripped before classification, and CJK/Hangul keywords match as plain substrings.

## Classifiers

Each router picks its backends and how they combine:

```jsonc
{
  "routers": [
    {
      "name": "hybrid",
      "classifiers": ["heuristic", "bert", "apple-fm"],   // run order
      "classifierCombination": "priority",                 // or "vote"
      "classifierOptions": {
        "heuristic": { "shortCircuitTiers": ["SIMPLE", "REASONING"] },
        "bert": {
          "model": "mustafacolakoglu94/llm-query-complexity-classifier-onnx",
          "onnxFile": "onnx/model_quantized.onnx",
          "timeoutMs": 10000,
          "labelToTier": { "LOW": "SIMPLE", "MEDIUM": "MEDIUM", "HIGH": "COMPLEX" }
        },
        "apple-fm": { "timeoutMs": 15000 }
      }
    }
  ]
}
```

- **`heuristic`** (default) — the LiteLLM-port keyword scorer. <1 ms, zero deps.
- **`bert`** — local ONNX text classifier via `@huggingface/transformers` (optional dependency; the dynamic import fails soft when it is not installed). Default model is a ModernBERT fine-tune of `anasnassar/llm-query-complexity-classifier` (Apache-2.0, labels LOW/MEDIUM/HIGH, 8k context). First use downloads ~144 MB to the HF cache; after that it runs fully offline — measured warm latency ~5 ms on Apple Silicon, and it handles Korean prompts directly (no keyword lists needed).
- **`apple-fm`** — macOS 26+ Apple Foundation Models via `@meridius-labs/apple-on-device-ai` (optional, darwin-only). Guided generation with a JSON schema forces exactly one tier label. Measured warm latency ~250–350 ms; requires Apple Intelligence enabled.

**Combination modes**

| Mode | Behavior |
|------|----------|
| `priority` (default) | Backends run in order; the first confident verdict wins. `shortCircuitTiers` (default `SIMPLE`, `REASONING`) end evaluation immediately, and a backend below `minConfidence` (default `0.5`) is skipped. A failing backend (module missing, timeout, model unavailable) falls through to the next one. |
| `vote` | All backends run in parallel; the highest-confidence tier wins. `vote-unanimous` / `vote-contested` in the log shows agreement. |

Shorthand: `"classifier": "bert"` equals `classifiers: ["bert"]`. Omitting both leaves heuristic-only, matching pre-`classifiers` configs exactly.

Common recipes:

```jsonc
// cheap + accurate: heuristic fast-path, BERT for everything else
{ "classifiers": ["heuristic", "bert"] }

// BERT first, heuristic as fallback only
{ "classifiers": ["bert", "heuristic"] }

// privacy-heavy arbitration: heuristic decides most, Apple FM judges the rest
{ "classifiers": ["heuristic", "apple-fm"], "classifierCombination": "priority" }

// three-way vote
{ "classifiers": ["heuristic", "bert", "apple-fm"], "classifierCombination": "vote" }
```

A backend that errors is never fatal: `priority` moves to the next backend, `vote` drops it, and if every backend fails the router falls back to MEDIUM.

## Installation

Two registrations are needed — the plugin and a local "router model" that acts as the switch:

```jsonc
// opencode.json (global or project)
{
  "plugin": [
    "git+https://github.com/leecoder/opencode-auto-router.git#v0.1.2"
  ],
  "provider": {
    "auto-router": {
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "dgc": {
          "name": "Auto Router (GLM/DS/Claude tiers)",
          "limit": { "context": 1048576, "output": 128000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  }
}
```

The GitHub plugin reference is pinned to a release tag. The release includes
the built `dist/` directory because OpenCode may block dependency lifecycle
scripts during Git installs. The `prepare` script remains available for local
source checkouts.

No `options`/`baseURL` needed — `options` is optional in the provider schema, and the hook swaps the model before any request is built, so a URL is never used. If the plugin is disabled and you select the router model anyway, OpenCode fails fast with `"undefined/chat/completions" cannot be parsed as a URL` — a clear signal the router isn't active.

## Configuration

`~/.config/opencode/opencode-auto-router.json` (also scanned: `~/.opencode/`, project `./.opencode/`, project root; `.jsonc` supported):

```json
{
  "notify": true,
  "enabled": true,
  "routers": [
    {
      "name": "dgc",
      "pinSession": true,
      "tierModels": {
        "SIMPLE": "litellm/databricks/databricks-glm-5-3-flash",
        "MEDIUM": "litellm/databricks/databricks-deepseek-v4-flash-0731",
        "COMPLEX": { "model": "litellm/sonnet-5", "variant": "high" },
        "REASONING": "litellm/opus-5"
      }
    }
  ]
}
```

### Multiple routers

Register as many routing tables as you like — each with its own name and tier mapping. Selecting `auto-router/{name}` activates that routing table:

```json
{
  "routers": [
    {
      "name": "cheap",
      "tierModels": {
        "SIMPLE": "litellm/glm-4.7-flash",
        "MEDIUM": "litellm/glm-5",
        "COMPLEX": "litellm/sonnet-5",
        "REASONING": "litellm/opus-5"
      }
    },
    {
      "name": "premium",
      "tierModels": {
        "SIMPLE": "litellm/sonnet-5",
        "MEDIUM": "litellm/sonnet-5",
        "COMPLEX": "litellm/opus-5",
        "REASONING": "litellm/opus-5"
      }
    }
  ]
}
```

Each router is selected as `auto-router/{name}` and needs a matching model with that id in `opencode.json`'s `provider.auto-router.models`. Single-router shorthand also works — top-level `tierModels` / keyword fields form one implicit router when `routers` is absent; its default name is `router-0`.

### Which model should you select in OpenCode?

| Selection | Behavior |
|-----------|----------|
| `auto-router/{name}` (for example `auto-router/dgc`) | Routed per-message to the tier the classifier picks |
| Any other model (`litellm/auto-dgc`, `kiro/claude-sonnet-4-6`, …) | Used exactly as you picked — routing never touches it |

### Router options

| Option | Description |
|--------|-------------|
| `name` | Router name and model id suffix for `auto-router/{name}` (default `router-0`, `router-1`, …) |
| `tierModels` | Tier → `provider/model-id` mapping (defaults: the GLM/DS/Claude mapping above) |
| `tierModels` values | Use a string, or `{ "model": "provider/model-id", "variant": "..." }` to keep the variant beside the model |
| `defaultModel` | Fallback when no tier can be determined (default: `tierModels.MEDIUM`) |
| `codeKeywords` / `reasoningKeywords` / `technicalKeywords` / `simpleKeywords` | Keyword list overrides (defaults: LiteLLM's) |
| `dimensionWeights` | Scoring weight overrides |
| `tierBoundaries` | `simple_medium`, `medium_complex`, `complex_reasoning` |
| `tokenThresholds` | `simple` (short) / `complex` (long) token boundaries |
| `pinSession` | Pin the first session decision for the whole session (default `false`) |
| `firstMessageOnly` | Route only the first message of a session |
| `agents` / `excludeAgents` | Restrict routing to / exclude specific agents |
| `classifier` / `classifiers` | Backend selection (shorthand / full list). Default: heuristic-only |
| `classifierCombination` | `priority` (default) or `vote` — see [Classifiers](#classifiers) |
| `classifierOptions` | Per-backend overrides: `model`, `onnxFile`, `labelToTier`, `timeoutMs`, `minConfidence`, `shortCircuitTiers`, `instructions` |

Top-level options: `enabled` (master switch, default `true`), `notify` (log tier changes, default `true`).

## Development

```bash
npm install
npx tsup          # build → dist/
npm test          # node --test test/*.test.mjs
```

## License

MIT
