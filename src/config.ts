import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PROVIDERS } from "./providers.js";

export const CONFIG_FILE = "novel.json";

const ConfigSchema = z.object({
    range: z.object({
        start: z.number().int().min(1),
        end: z.number().int().min(1),
    }),

    inputFolder: z.string().default("chapters"),
    outputFolder: z.string().default("translation"),
    glossaryFile: z.string().default("glossary.db"),
    /** Chapter files are named `{index padded to N}.txt` / `.json`. */
    filePad: z.number().int().min(1).default(5),

    sourceLanguage: z.string().default("English"),
    targetLanguage: z.string().default("Ukrainian"),

    provider: z.enum(PROVIDERS).default("openai"),
    /** Defaults per provider (see PROVIDER_DEFAULTS); required for google. */
    model: z.string().optional(),
    /** Env variable holding the API key; defaults per provider. */
    apiKeyEnv: z.string().optional(),
    /** Custom endpoint for the provider (OpenAI-compatible proxies, OpenRouter, ...). */
    baseURL: z.string().optional(),
    /** Not accepted by current Claude models (400); leave unset there. */
    temperature: z.number().optional(),
    /** Reasoning depth: OpenAI reasoningEffort / Anthropic effort. Ignored by google. */
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
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

    debug: z
        .object({
            savePrompts: z.boolean().default(false),
            folder: z.string().default("debug"),
        })
        .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema> & { root: string };

export async function loadConfig(root = process.cwd()): Promise<Config> {
    const file = path.join(root, CONFIG_FILE);
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf-8");
    } catch {
        throw new Error(
            `${CONFIG_FILE} not found in ${root}. Run "ranobe-tl init" first.`
        );
    }
    const parsed = ConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
        throw new Error(`Invalid ${CONFIG_FILE}:\n${z.prettifyError(parsed.error)}`);
    }
    if (parsed.data.range.end < parsed.data.range.start) {
        throw new Error("range.end must be >= range.start");
    }
    return { ...parsed.data, root };
}

export function chapterFile(config: Config, kind: "input" | "output", index: number): string {
    const name = index.toString().padStart(config.filePad, "0");
    return kind === "input"
        ? path.resolve(config.root, config.inputFolder, `${name}.txt`)
        : path.resolve(config.root, config.outputFolder, `${name}.json`);
}

export const CONFIG_TEMPLATE = {
    range: { start: 1, end: 100 },
    provider: "openai",
    model: "gpt-6-luna",
    sourceLanguage: "English",
    targetLanguage: "Ukrainian",
    stringsToRemove: [],
    fixedTerms: {},
    instructions: "",
};
