import {
  modelKey
} from "./chunk-XVEMK6MM.js";

// src/config-loader.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
function findRouterForModel(input) {
  const key = modelKey(input.providerID, input.modelID);
  if (!key) return null;
  for (const router of input.config.routers) {
    if (modelKey("auto-router", router.name) === key) return router;
  }
  return null;
}
var CONFIG_FILENAMES = ["opencode-auto-router.json", "opencode-auto-router.jsonc"];
function findConfigFile() {
  const candidates = [
    join(process.cwd(), ".opencode", CONFIG_FILENAMES[0]),
    join(process.cwd(), ".opencode", CONFIG_FILENAMES[1]),
    join(process.cwd(), CONFIG_FILENAMES[0]),
    join(process.env.HOME ?? "~", ".config", "opencode", CONFIG_FILENAMES[0]),
    join(process.env.HOME ?? "~", ".config", "opencode", CONFIG_FILENAMES[1]),
    join(process.env.HOME ?? "~", ".opencode", CONFIG_FILENAMES[0])
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return { path: candidate, raw: readFileSync(candidate, "utf-8") };
      }
    } catch {
    }
  }
  return null;
}
function parseConfigFile(raw, isJsonc) {
  const cleaned = isJsonc ? raw.replace(/(?<![:"\\])\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "") : raw;
  return JSON.parse(cleaned);
}
function loadConfig() {
  try {
    const found = findConfigFile();
    if (!found) return void 0;
    const isJsonc = found.path.endsWith(".jsonc");
    return parseConfigFile(found.raw, isJsonc);
  } catch {
    return void 0;
  }
}

export {
  findRouterForModel,
  findConfigFile,
  parseConfigFile,
  loadConfig
};
