import { Ban, Coins, Cpu, Languages } from "lucide-react";
import { Page, PageHeader, StatCard } from "@/components/page-header";
import { PricesDialog } from "@/components/usage/prices-dialog";
import { SpendChart } from "@/components/usage/spend-chart";
import { UsageFiltersBar } from "@/components/usage/usage-filters";
import { UsageTables } from "@/components/usage/usage-tables";
import { formatTokens } from "@/lib/utils";
import { formatUsd } from "@/server/pricing";
import { requireUser } from "@/server/session";
import { RANGES, usageReport, type Range } from "@/server/usage";

export const metadata = { title: "Usage" };

export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
    const me = await requireUser();
    const sp = await searchParams;
    const range = (sp.range && sp.range in RANGES ? sp.range : "30d") as Range;
    const filters = {
        range,
        novelId: Number(sp.novel) || undefined,
        provider: sp.provider || undefined,
        model: sp.model || undefined,
        keyId: Number(sp.key) || undefined,
    };
    const r = await usageReport(filters);
    const t = r.totals;
    const chapters = r.novels.reduce((a, n) => a + n.chapters, 0);

    return (
        <Page>
            <PageHeader
                title="Usage"
                description="What the translators spent, by day, model and novel. Costs use the price table, so fixing a price fixes the history too."
                actions={<PricesDialog prices={r.prices} models={r.options.models} isAdmin={me.role === "admin"} />}
            />
            <div className="mt-6">
                <UsageFiltersBar options={r.options} />
            </div>
            {r.unpriced.length > 0 && (
                <div className="mt-4 rounded-xl border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
                    No price for {r.unpriced.map((m) => <code key={m} className="mx-0.5 rounded bg-muted px-1 font-mono text-xs">{m}</code>)}: counted as $0. Set it in Prices.
                </div>
            )}
            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Spent" value={formatUsd(t.cost, 2)} hint={`${RANGES[range] ? `last ${RANGES[range]} days` : "all time"}`} icon={Coins} />
                <StatCard label="Per chapter" value={chapters ? formatUsd(t.cost / chapters) : "—"} hint={`${chapters} chapters translated`} icon={Languages} />
                <StatCard
                    label="Tokens"
                    value={formatTokens(t.inputTokens + t.outputTokens)}
                    hint={`${formatTokens(t.inputTokens)} in${t.cachedTokens ? ` (${Math.round((t.cachedTokens / Math.max(1, t.inputTokens)) * 100)}% cached)` : ""} · ${formatTokens(t.outputTokens)} out`}
                    icon={Cpu}
                />
                <StatCard
                    label="Wasted on retries"
                    value={formatUsd(t.wasted, 2)}
                    hint={t.requests ? `${t.failed} of ${t.requests} requests rejected (${Math.round((t.failed / t.requests) * 100)}%)` : "no requests"}
                    icon={Ban}
                />
            </div>
            <div className="mt-6">
                <SpendChart data={r.chart} series={r.series} />
            </div>
            <div className="mt-6">
                <UsageTables models={r.models} novels={r.novels} />
            </div>
        </Page>
    );
}
