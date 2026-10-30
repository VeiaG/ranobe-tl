import { and, eq, inArray, sql } from "drizzle-orm";
import { PROVIDER_DEFAULTS, type Provider } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { chapter, novel, providerKey, usageRecord } from "@/db/schema";
import { spent } from "./budget";
import { BATCH_SUFFIX, costOf, getPrices, priceOf } from "./pricing";
import { scopeWhere, type RunScope } from "./scope";

/** Below this many translated chapters the novel's own history is too thin to extrapolate from. */
const MIN_HISTORY_CHAPTERS = 3;
/** Rough token density when there is no history: source text in, a similar amount of translation out. */
const SOURCE_CHARS_PER_TOKEN = 3.6;
const TARGET_CHARS_PER_TOKEN = 2.6;
/** System prompt, glossary and context sent with every request. */
const PROMPT_OVERHEAD_TOKENS = 2000;
const RETRY_FACTOR = 1.15;

export interface Estimate {
    chapters: number;
    chars: number;
    usd: number | null;
    model: string;
    basis: "history" | "guess";
    /** Spent so far and the novel's budget, to warn before starting. */
    spentUsd: number;
    budgetUsd: number | null;
}

export async function estimateRun(db: DB, novelId: number, scope: RunScope): Promise<Estimate> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n) throw new Error("novel not found");
    const [key] = n.providerKeyId ? await db.select().from(providerKey).where(eq(providerKey.id, n.providerKeyId)) : [];
    const model = n.model || (key ? (PROVIDER_DEFAULTS[key.provider as Provider]?.model ?? "") : "");

    const [sel] = await db
        .select({ chapters: sql<number>`count(*)::int`, chars: sql<number>`coalesce(sum(length(${chapter.source})), 0)::float8` })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), inArray(chapter.status, ["new", "failed", "skipped", "done", "queued"]), scopeWhere(scope)));

    const { usd: spentUsd } = await spent(db, eq(usageRecord.novelId, novelId));
    const prices = await getPrices(db);
    // batches cost half; their usage is recorded as "<model>:batch"
    const price = priceOf(prices, n.pipeline === "batch" ? `${model}${BATCH_SUFFIX}` : model);

    // the novel's own cost per source character, failures included, is the best predictor
    const [done] = await db
        .select({ chapters: sql<number>`count(*)::int`, chars: sql<number>`coalesce(sum(length(${chapter.source})), 0)::float8` })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), eq(chapter.status, "done")));
    if (done.chapters >= MIN_HISTORY_CHAPTERS && done.chars > 0 && spentUsd > 0) {
        return { chapters: sel.chapters, chars: sel.chars, usd: (spentUsd / done.chars) * sel.chars, model, basis: "history", spentUsd, budgetUsd: n.budgetUsd };
    }

    const requests = Math.max(sel.chapters, 1);
    const tokens = {
        inputTokens: (sel.chars / SOURCE_CHARS_PER_TOKEN + requests * PROMPT_OVERHEAD_TOKENS) * RETRY_FACTOR,
        cachedTokens: 0,
        outputTokens: (sel.chars / TARGET_CHARS_PER_TOKEN) * RETRY_FACTOR,
    };
    return { chapters: sel.chapters, chars: sel.chars, usd: sel.chapters ? costOf(tokens, price) : 0, model, basis: "guess", spentUsd, budgetUsd: n.budgetUsd };
}
