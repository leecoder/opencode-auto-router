import { NormalizedPluginConfig, NormalizedRouter, PluginConfig } from './config.js';
export { BoundaryName, DEFAULT_TIER_MODELS, DimensionName, RouterConfig, Tier, TierModels, modelKey, normalizeConfig, normalizeRouter } from './config.js';

interface FindRouterInput {
    config: NormalizedPluginConfig;
    providerID?: string;
    modelID?: string;
}
/** First router whose `auto-router/{name}` model matches the session's selection.
 *  Null when the selection matches no router — routing stays off for that
 *  turn and the picked model is used as-is. */
declare function findRouterForModel(input: FindRouterInput): NormalizedRouter | null;
interface FoundConfigFile {
    path: string;
    raw: string;
}
declare function findConfigFile(): FoundConfigFile | null;
declare function parseConfigFile(raw: string, isJsonc: boolean): PluginConfig;
declare function loadConfig(): PluginConfig | undefined;

export { type FindRouterInput, type FoundConfigFile, NormalizedPluginConfig, NormalizedRouter, PluginConfig, findConfigFile, findRouterForModel, loadConfig, parseConfigFile };
