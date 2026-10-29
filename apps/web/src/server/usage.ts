import "server-only";
import { and, asc, eq, gte, min, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { novel, providerKey, usageRecord } from "@/db/schema";
import { costOf, getPrices, type Price } from "./pricing";

export const RANGES = { "7d": 7, "30d": 30, "90d": 90, all: null } as const;
export type Range = keyof typeof RANGES;

export interface UsageFilters {
    range: Range;
    novelId?: number;
    provider?: string;
    model?: string;
    keyId?: number;
}

/** At most this many models get their own color; the rest fold into "Other". */
export const MAX_SERIES = 8;

function where(f: UsageFilters): SQL | undefined {
    const days = RANGES[f.range];
    return and(
        days ? gte(usageRecord.createdAt, new Date(Date.now() - days * 86_400_000)) : undefined,
        f.novelId ? eq(usageRecord.novelId, f.novelId) : undefined,
        f.provider ? eq(usageRecord.provider, f.provider) : undefined,
        f.model ? eq(usageRecord.model, f.model) : undefined,
        f.keyId ? eq(usageRecord.keyId, f.keyId) : undefined
    );
}

const sums = {
    inputTokens: sql<number>`coalesce(sum(${usageRecord.inputTokens}), 0)::float8`,
    cachedTokens: sql<number>`coalesce(sum(${usageRecord.cachedTokens}), 0)::float8`,
    outputTokens: sql<number>`coalesce(sum(${usageRecord.outputTokens}), 0)::float8`,
    requests: sql<number>`count(*)::int`,
};

export async function usageReport(f: UsageFilters) {
    const w = where(f);
    const prices = await getPrices(db);
    const cost = (r: { inputTokens: number; cachedTokens: number; outputTokens: number; model: string }) => costOf(r, prices[r.model]);

    const [byDayModel, byModelOk, byNovel, allModels, novels, keys, providers] = await Promise.all([
        db
            .select({ day: sql<string>`to_char(date_trunc('day', ${usageRecord.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`, model: usageRecord.model, ...sums })
            .from(usageRecord)
            .where(w)
            .groupBy(sql`1`, usageRecord.model)
            .orderBy(sql`1`),
        db
            .select({ model: usageRecord.model, provider: usageRecord.provider, ok: usageRecord.ok, ...sums })
            .from(usageRecord)
            .where(w)
            .groupBy(usageRecord.model, usageRecord.provider, usageRecord.ok),
        db
            .select({
                novelId: usageRecord.novelId,
                novelTitle: usageRecord.novelTitle,
                model: usageRecord.model,
                chapters: sql<number>`count(distinct ${usageRecord.chapter}) filter (where ${usageRecord.ok})::int`,
                ...sums,
            })
            .from(usageRecord)
            .where(w)
            .groupBy(usageRecord.novelId, usageRecord.novelTitle, usageRecord.model),
        // color order: every model ever seen, by first appearance, so filters never repaint a series
        db.select({ model: usageRecord.model, first: min(usageRecord.id) }).from(usageRecord).groupBy(usageRecord.model).orderBy(asc(min(usageRecord.id))),
        db.select({ id: novel.id, title: novel.title }).from(novel).orderBy(asc(novel.title)),
        db.select({ id: providerKey.id, name: providerKey.name, provider: providerKey.provider }).from(providerKey).orderBy(asc(providerKey.name)),
        db.selectDistinct({ provider: usageRecord.provider }).from(usageRecord).orderBy(asc(usageRecord.provider)),
    ]);

    const colorOf = new Map<string, string>();
    allModels.forEach((m, i) => colorOf.set(m.model, i < MAX_SERIES ? `var(--series-${i + 1})` : "var(--series-other)"));

    const unpriced = new Set<string>();
    const priced = (r: Parameters<typeof cost>[0]) => {
        const c = cost(r);
        if (c === null) unpriced.add(r.model);
        return c ?? 0;
    };

    // chart rows: one per day, a key per model (cost and tokens)
    const days = new Map<string, Record<string, number | string>>();
    const modelsInRange = new Set<string>();
    for (const r of byDayModel) {
        const row = days.get(r.day) ?? { day: r.day };
        const series = colorOf.get(r.model)?.includes("other") ? "Other" : r.model;
        modelsInRange.add(series);
        row[`cost:${series}`] = ((row[`cost:${series}`] as number) ?? 0) + priced(r);
        row[`tokens:${series}`] = ((row[`tokens:${series}`] as number) ?? 0) + r.inputTokens + r.outputTokens;
        days.set(r.day, row);
    }

    const models = new Map<string, { model: string; provider: string; requests: number; failed: number; inputTokens: number; cachedTokens: number; outputTokens: number; cost: number; wasted: number }>();
    const totals = { cost: 0, wasted: 0, requests: 0, failed: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    for (const r of byModelOk) {
        const m = models.get(r.model) ?? { model: r.model, provider: r.provider, requests: 0, failed: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0, wasted: 0 };
        const c = priced(r);
        m.requests += r.requests;
        m.inputTokens += r.inputTokens;
        m.cachedTokens += r.cachedTokens;
        m.outputTokens += r.outputTokens;
        m.cost += c;
        if (!r.ok) {
            m.failed += r.requests;
            m.wasted += c;
        }
        models.set(r.model, m);
        totals.cost += c;
        totals.requests += r.requests;
        totals.inputTokens += r.inputTokens;
        totals.cachedTokens += r.cachedTokens;
        totals.outputTokens += r.outputTokens;
        if (!r.ok) {
            totals.wasted += c;
            totals.failed += r.requests;
        }
    }

    const novelRows = new Map<string, { novelId: number | null; title: string; chapters: number; cost: number; tokens: number; models: Set<string> }>();
    for (const r of byNovel) {
        const key = `${r.novelId ?? "deleted"}:${r.novelId ? "" : r.novelTitle}`;
        const n = novelRows.get(key) ?? { novelId: r.novelId, title: r.novelTitle || "(deleted novel)", chapters: 0, cost: 0, tokens: 0, models: new Set<string>() };
        n.chapters += r.chapters;
        n.cost += priced(r);
        n.tokens += r.inputTokens + r.outputTokens;
        n.models.add(r.model);
        novelRows.set(key, n);
    }

    const series = [...modelsInRange].sort((a, b) => {
        const ia = allModels.findIndex((m) => m.model === a);
        const ib = allModels.findIndex((m) => m.model === b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

    return {
        totals,
        chart: [...days.values()],
        series: series.map((name) => ({ name, color: name === "Other" ? "var(--series-other)" : (colorOf.get(name) ?? "var(--series-other)") })),
        models: [...models.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests).map((m) => ({ ...m, color: colorOf.get(m.model) ?? "var(--series-other)" })),
        novels: [...novelRows.values()].sort((a, b) => b.cost - a.cost).map((n) => ({ ...n, models: [...n.models] })),
        unpriced: [...unpriced],
        options: { novels, keys, providers: providers.map((p) => p.provider), models: allModels.map((m) => m.model) },
        prices: prices as Record<string, Price>,
    };
}
export type UsageReport = Awaited<ReturnType<typeof usageReport>>;
