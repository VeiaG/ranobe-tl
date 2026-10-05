import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Config } from "./config.js";

export function createModel(config: Config): LanguageModel {
    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) {
        throw new Error(`API key not found: set ${config.apiKeyEnv} in the environment or in a .env file`);
    }
    switch (config.provider) {
        case "openai":
            return createOpenAI({ apiKey, baseURL: config.baseURL })(config.model);
    }
}
