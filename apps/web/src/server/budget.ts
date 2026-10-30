import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import type { DB } from "@/db";
import { usageRecord } from "@/db/schema";
import { costOf, priceOf, pricedModel, formatUsd, getPrices } from "./pricing";

/** Spend in USD over matching records; models without a price count as 0 (and are reported). */
export async function spent(db: DB, where: SQL | undefined): Promise<{ usd: number; unpriced: string[] }> {
    const rows = await db
        .select({
            model: usageRecord.model,
            inputTokens: sql<number>`coalesce(sum(${usageRecord.inputTokens}), 0)::float8`,
            cachedTokens: sql<number>`coalesce(sum(${usageRecord.cachedTokens}), 0)::float8`,
            outputTokens: sql<number>`coalesce(sum(${usageRecord.outputTokens}), 0)::float8`,
        })
        .from(usageRecord)
        .where(where)
        .groupBy(usageRecord.model);
    const prices = await getPrices(db);
    let usd = 0;
    const unpriced: string[] = [];
    for (const r of rows) {
        const c = costOf(r, priceOf(prices, r.model));
        if (c !== null) usd += c;
        else if (!unpriced.includes(pricedModel(r.model))) unpriced.push(pricedModel(r.model));
    }
    return { usd, unpriced };
}

export function monthStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Why the novel may not spend more right now, or null. */
export async function budgetStop(
    db: DB,
    n: { id: number; budgetUsd: number | null },
    key: { id: number; name: string; monthlyBudgetUsd: number | null } | undefined
): Promise<string | null> {
    if (n.budgetUsd !== null && n.budgetUsd !== undefined) {
        const { usd } = await spent(db, eq(usageRecord.novelId, n.id));
        if (usd >= n.budgetUsd) return `budget reached: ${formatUsd(usd)} spent of ${formatUsd(n.budgetUsd)} for this novel`;
    }
    if (key && key.monthlyBudgetUsd !== null && key.monthlyBudgetUsd !== undefined) {
        const { usd } = await spent(db, and(eq(usageRecord.keyId, key.id), gte(usageRecord.createdAt, monthStart())));
        if (usd >= key.monthlyBudgetUsd) return `monthly budget of the key "${key.name}" reached: ${formatUsd(usd)} of ${formatUsd(key.monthlyBudgetUsd)}`;
    }
    return null;
}
