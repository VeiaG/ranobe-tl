import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

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

    provider: z.enum(["openai"]).default("openai"),
    model: z.string().default("gpt-4.1"),
    /** Env variable holding the API key. */
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    /** Optional OpenAI-compatible endpoint (OpenRouter, proxies, ...). */
    baseURL: z.string().optional(),
    temperature: z.number().optional(),

    chunkSize: z.number().int().min(1000).default(15000),
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
    model: "gpt-4.1",
    sourceLanguage: "English",
    targetLanguage: "Ukrainian",
    stringsToRemove: [],
    fixedTerms: {},
    instructions: "",
};
