import { and, count, eq, ne, sql } from "drizzle-orm";
import { EFFORTS, TERM_TYPES, type AskNewPolicy } from "@ranobe-tl/core";
import { z } from "zod";
import type { DB } from "@/db";
import { DECISION_MODES, chapter, novel } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { getSetting } from "./settings";

/** Instance-wide settings an admin changes in Settings → Instance; the worker reads them live. */
export const InstanceSchema = z.object({
    /** Novels translating at the same time across all workers. */
    concurrency: z.number().int().min(1).max(32),
    defaults: z.object({
        sourceLanguage: z.string(),
        targetLanguage: z.string(),
        providerKeyId: z.number().int().nullable(),
        model: z.string(),
        decisionMode: z.enum(DECISION_MODES),
        askNew: z.object({ types: z.array(z.enum(TERM_TYPES)).optional(), untilChapter: z.number().int().optional() }).nullable(),
    }),
    /** The model for small helper tasks (suggesting cleanup patterns…), not for translation. */
    service: z.object({
        providerKeyId: z.number().int().nullable(),
        model: z.string(),
        effort: z.enum(EFFORTS).nullable(),
    }),
});
export type InstanceConfig = z.infer<typeof InstanceSchema>;

export const INSTANCE_KEY = "instance";

export function instanceDefaults(): InstanceConfig {
    return {
        concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2)),
        defaults: { sourceLanguage: "English", targetLanguage: "Ukrainian", providerKeyId: null, model: "", decisionMode: "queue", askNew: null as AskNewPolicy | null },
        service: { providerKeyId: null, model: "", effort: null },
    };
}

export async function instanceConfig(db: DB): Promise<InstanceConfig> {
    const fallback = instanceDefaults();
    const saved = await getSetting<Partial<InstanceConfig>>(db, INSTANCE_KEY, {});
    return { ...fallback, ...saved, defaults: { ...fallback.defaults, ...(saved.defaults ?? {}) }, service: { ...fallback.service, ...(saved.service ?? {}) } };
}

export const TELEGRAM_KEY = "telegram";

/** The bot token set in the UI wins over TELEGRAM_BOT_TOKEN, so the bot can be set up without touching .env. */
export async function telegramToken(db: DB): Promise<string | null> {
    const saved = await getSetting<{ tokenEncrypted?: string }>(db, TELEGRAM_KEY, {});
    if (saved.tokenEncrypted) {
        try {
            return decrypt(saved.tokenEncrypted);
        } catch {
            return null;
        }
    }
    return process.env.TELEGRAM_BOT_TOKEN || null;
}

/**
 * Takes a translation slot for a chapter, or says why it has to wait. The check and the claim run
 * under one advisory lock, so several workers never overbook the global or a key's limit.
 */
export async function claimSlot(
    db: DB,
    chapterId: number,
    novelId: number,
    key: { id: number; name: string; maxParallel: number | null }
): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { concurrency } = await instanceConfig(db);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(726355)`);
        const busy = (where?: ReturnType<typeof eq>) =>
            tx
                .select({ n: count() })
                .from(chapter)
                .innerJoin(novel, eq(novel.id, chapter.novelId))
                .where(and(eq(chapter.status, "translating"), eq(novel.status, "running"), ne(chapter.novelId, novelId), where))
                .then((r) => r[0].n);
        const all = await busy();
        if (all >= concurrency) return { ok: false as const, reason: `waiting for a free slot (${all} of ${concurrency} busy)` };
        if (key.maxParallel) {
            const forKey = await busy(eq(novel.providerKeyId, key.id));
            if (forKey >= key.maxParallel) return { ok: false as const, reason: `waiting for the key "${key.name}" (${forKey} of ${key.maxParallel} busy)` };
        }
        await tx.update(chapter).set({ status: "translating", error: "" }).where(eq(chapter.id, chapterId));
        return { ok: true as const };
    });
}
