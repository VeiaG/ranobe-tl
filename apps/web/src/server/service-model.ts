import "server-only";
import { eq } from "drizzle-orm";
import { generateText, Output } from "ai";
import type { z } from "zod";
import { createModel, parseConfig, resolveModelId, type TranslationConfig } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { providerKey, usageRecord } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { instanceConfig } from "./instance";

type Usage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined;

/**
 * The service model or the assistant model from Settings → Instance (the assistant falls back to
 * the service model). `record` stores a request's usage against the novel, without a chapter.
 */
export async function helperModel(db: DB, role: "service" | "assistant", novel?: { id: number; title: string }) {
    const config = await instanceConfig(db);
    const choice = role === "assistant" && config.assistant.providerKeyId ? config.assistant : config.service;
    if (!choice.providerKeyId) throw new Error(`Choose ${role === "assistant" ? "an assistant or a service" : "a service"} model in Settings → Instance first`);
    const [key] = await db.select().from(providerKey).where(eq(providerKey.id, choice.providerKeyId));
    if (!key) throw new Error("The API key chosen in Settings → Instance was deleted; choose another");
    const modelConfig = parseConfig({
        provider: key.provider as TranslationConfig["provider"],
        model: choice.model || undefined,
        baseURL: key.baseURL || undefined,
        effort: choice.effort ?? undefined,
    });
    const setup = createModel(modelConfig, decrypt(key.encryptedKey));
    const model = resolveModelId(modelConfig);
    const record = (usage: Usage, ok: boolean) =>
        db.insert(usageRecord).values({
            novelId: novel?.id ?? null,
            novelTitle: novel?.title ?? "",
            keyId: key.id,
            provider: key.provider,
            model,
            inputTokens: usage?.inputTokens ?? 0,
            cachedTokens: usage?.cachedInputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            ok,
        });
    return { setup, model, record };
}

/** Asks the service model for a structured answer. */
export async function askServiceModel<T>(db: DB, opts: { system: string; prompt: string; schema: z.ZodType<T>; novel?: { id: number; title: string } }): Promise<T> {
    const { setup, record } = await helperModel(db, "service", opts.novel);
    try {
        const res = await generateText({
            model: setup.model,
            system: opts.system,
            prompt: opts.prompt,
            providerOptions: setup.providerOptions,
            output: Output.object({ schema: opts.schema }),
        });
        await record(res.usage, true);
        return res.output;
    } catch (error) {
        // a reply that did not fit the schema was still paid for
        const usage = (error as { usage?: Usage }).usage;
        if (usage) await record(usage, false);
        throw error;
    }
}
