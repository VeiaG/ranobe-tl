import { z } from "zod";
import { PROVIDERS } from "./providers";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Everything the translator needs to know about a novel; storage and scheduling live elsewhere. */
export const TranslationConfigSchema = z.object({
    sourceLanguage: z.string().default("English"),
    targetLanguage: z.string().default("Ukrainian"),

    provider: z.enum(PROVIDERS).default("openai"),
    /** Defaults per provider (see PROVIDER_DEFAULTS); required for google. */
    model: z.string().optional(),
    /** Custom endpoint for the provider (OpenAI-compatible proxies, OpenRouter, ...). */
    baseURL: z.string().optional(),
    /** Not accepted by current Claude models (400); leave unset there. */
    temperature: z.number().optional(),
    /** Reasoning depth: OpenAI reasoningEffort / Anthropic effort. Ignored by google. */
    effort: z.enum(EFFORTS).optional(),
    /** Output token limit per request; a full chapter needs ~10–15k. */
    maxOutputTokens: z.number().int().min(1000).default(32000),

    chunkSize: z.number().int().min(1000).default(8000),
    /** Attempts per chunk when the output fails validation or the request errors. */
    maxAttempts: z.number().int().min(1).default(3),
    /** Characters of the previous chunk's translation passed as context. */
    contextChars: z.number().int().min(0).default(1000),

    /** Exact strings removed from source text before translation. */
    stringsToRemove: z.array(z.string()).default([]),
    /** Regexes (multiline, case-insensitive) removed from source text. */
    patternsToRemove: z
        .array(z.string())
        .default(["^\\s*(Translator|Editor|Proofreader|TL|ED)\\s*:.*$"]),

    /** Always-on terms; treated as locked and sent with every chunk. */
    fixedTerms: z.record(z.string(), z.string()).default({}),
    /** Novel title and synopsis, given to the model as background. */
    novel: z
        .object({
            title: z.string().default(""),
            synopsis: z.string().default(""),
        })
        .prefault({}),
    /** Extra instructions appended to the system prompt. */
    instructions: z.string().default(""),

    validation: z
        .object({
            minSourceChars: z.number().default(1000),
            /** translation length / source length, per chunk. */
            minRatio: z.number().default(0.8),
            maxRatio: z.number().default(1.15),
            /** Max share of Latin letters among all letters in the output, %. */
            maxLatinPercent: z.number().default(3),
            /** Max characters covered by one phrase repeated back to back ("the the the …"). */
            maxRepeatSpan: z.number().default(200),
            /** Max share of source paragraphs that may go missing (merged or summarized), per chunk. */
            maxParagraphLoss: z.number().min(0).max(1).default(0.1),
        })
        .prefault({}),
});

export type TranslationConfig = z.infer<typeof TranslationConfigSchema>;
export type TranslationConfigInput = z.input<typeof TranslationConfigSchema>;

export function parseConfig(input: TranslationConfigInput): TranslationConfig {
    return TranslationConfigSchema.parse(input);
}
