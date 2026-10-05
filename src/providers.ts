import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Config } from "./config.js";

export const PROVIDERS = ["openai", "anthropic", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_DEFAULTS: Record<Provider, { model?: string; apiKeyEnv: string }> = {
    openai: { model: "gpt-6-luna", apiKeyEnv: "OPENAI_API_KEY" },
    anthropic: { model: "claude-opus-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
    // Gemini ids change often; the model must be set explicitly.
    google: { apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY" },
};

type ProviderOptions = Record<string, Record<string, any>>;

export interface ModelSetup {
    model: LanguageModel;
    /** Per-request provider options (effort, safety settings, ...). */
    providerOptions: ProviderOptions;
    /** Options attached to the system message (prompt caching). */
    systemProviderOptions: ProviderOptions;
}

export function resolveModelId(config: Pick<Config, "provider" | "model">): string {
    const model = config.model ?? PROVIDER_DEFAULTS[config.provider].model;
    if (!model) throw new Error(`"model" must be set in novel.json for provider "${config.provider}"`);
    return model;
}

export function createModel(config: Config): ModelSetup {
    const apiKeyEnv = config.apiKeyEnv ?? PROVIDER_DEFAULTS[config.provider].apiKeyEnv;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
        throw new Error(`API key not found: set ${apiKeyEnv} in the environment or in a .env file`);
    }
    const modelId = resolveModelId(config);
    const { baseURL, effort } = config;

    switch (config.provider) {
        case "openai":
            return {
                model: createOpenAI({ apiKey, baseURL })(modelId),
                providerOptions: effort ? { openai: { reasoningEffort: effort } } : {},
                systemProviderOptions: {},
            };
        case "anthropic":
            return {
                model: createAnthropic({ apiKey, baseURL })(modelId),
                providerOptions: effort ? { anthropic: { effort } } : {},
                // Anthropic caches only explicitly marked prefixes; the system prompt is the same for every chunk.
                systemProviderOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            };
        case "google":
            return {
                model: createGoogleGenerativeAI({ apiKey, baseURL })(modelId),
                // Fiction is full of fights and villains; default thresholds block whole chapters.
                providerOptions: { google: { threshold: "BLOCK_NONE" } },
                systemProviderOptions: {},
            };
    }
}
