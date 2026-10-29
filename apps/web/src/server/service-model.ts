import "server-only";
import { eq } from "drizzle-orm";
import { generateText, Output } from "ai";
import type { z } from "zod";
import { createModel, parseConfig, resolveModelId, type TranslationConfig } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { providerKey, usageRecord } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { instanceConfig } from "./instance";

/**
 * Asks the service model (Settings → Instance) for a structured answer. Its usage is recorded
 * like translation requests, against the novel it was for and without a chapter.
 */
export async function askServiceModel<T>(db: DB, opts: { system: string; prompt: string; schema: z.ZodType<T>; novel?: { id: number; title: string } }): Promise<T> {
    const { service } = await instanceConfig(db);
    if (!service.providerKeyId) throw new Error("Choose a service model in Settings → Instance first");
    const [key] = await db.select().from(providerKey).where(eq(providerKey.id, service.providerKeyId));
    if (!key) throw new Error("The service model's API key was deleted; choose another in Settings → Instance");
    const config = parseConfig({
        provider: key.provider as TranslationConfig["provider"],
        model: service.model || undefined,
        baseURL: key.baseURL || undefined,
        effort: service.effort ?? undefined,
    });
    const setup = createModel(config, decrypt(key.encryptedKey));
    const model = resolveModelId(config);

    const record = (usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined, ok: boolean) =>
        db.insert(usageRecord).values({
            novelId: opts.novel?.id ?? null,
            novelTitle: opts.novel?.title ?? "",
            keyId: key.id,
            provider: key.provider,
            model,
            inputTokens: usage?.inputTokens ?? 0,
            cachedTokens: usage?.cachedInputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            ok,
        });

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
        const usage = (error as { usage?: Parameters<typeof record>[0] }).usage;
        if (usage) await record(usage, false);
        throw error;
    }
}
