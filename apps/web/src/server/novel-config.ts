import { z } from "zod";
import { EFFORTS, TranslationConfigSchema, parseConfig, type TranslationConfig } from "@ranobe-tl/core";
import type { novel, providerKey } from "@/db/schema";

type Novel = typeof novel.$inferSelect;
type ProviderKey = typeof providerKey.$inferSelect;

/** The part of TranslationConfig stored in novel.settings (the rest has its own columns). */
export const NovelSettingsSchema = z.object({
    effort: z.enum(EFFORTS).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1000).optional(),
    chunkSize: z.number().int().min(1000).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    contextChars: z.number().int().min(0).optional(),
    instructions: z.string().optional(),
    fixedTerms: z.record(z.string(), z.string()).optional(),
    stringsToRemove: z.array(z.string()).optional(),
    patternsToRemove: z.array(z.string()).optional(),
    validation: TranslationConfigSchema.shape.validation.unwrap().partial().optional(),
});
export type NovelSettings = z.infer<typeof NovelSettingsSchema>;

export function novelSettings(n: Pick<Novel, "settings">): NovelSettings {
    const parsed = NovelSettingsSchema.safeParse(n.settings ?? {});
    return parsed.success ? parsed.data : {};
}

export function novelConfig(n: Novel, key: Pick<ProviderKey, "provider" | "baseURL"> | null | undefined): TranslationConfig {
    const settings = novelSettings(n);
    return parseConfig({
        ...settings,
        provider: (key?.provider ?? "openai") as TranslationConfig["provider"],
        model: n.model || undefined,
        baseURL: key?.baseURL || undefined,
        sourceLanguage: n.sourceLanguage,
        targetLanguage: n.targetLanguage,
        novel: { title: n.originalTitle || n.title, synopsis: n.synopsis },
    });
}
