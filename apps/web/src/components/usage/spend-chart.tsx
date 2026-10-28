"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn, formatTokens } from "@/lib/utils";

type Metric = "cost" | "tokens";

function usd(n: number) {
    return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

/** Every day between the first and the last, so gaps read as zero instead of disappearing. */
function fillDays(rows: Record<string, number | string>[]): Record<string, number | string>[] {
    if (rows.length < 2) return rows;
    const byDay = new Map(rows.map((r) => [String(r.day), r]));
    const out: Record<string, number | string>[] = [];
    const end = new Date(`${rows[rows.length - 1].day}T00:00:00Z`);
    for (let d = new Date(`${rows[0].day}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const day = d.toISOString().slice(0, 10);
        out.push(byDay.get(day) ?? { day });
    }
    return out;
}

/** Daily spend, stacked by model; colors follow the model, never its rank. */
export function SpendChart({ data, series }: { data: Record<string, number | string>[]; series: { name: string; color: string }[] }) {
    const [metric, setMetric] = useState<Metric>("cost");

    // chart keys become CSS variable names, so models get safe keys s0, s1, …
    const { rows, config } = useMemo(() => {
        const config: ChartConfig = {};
        series.forEach((s, i) => (config[`s${i}`] = { label: s.name, color: s.color }));
        const rows = fillDays(data).map((r) => {
            const row: Record<string, number | string> = { day: r.day };
            series.forEach((s, i) => (row[`s${i}`] = Number(r[`${metric}:${s.name}`] ?? 0)));
            return row;
        });
        return { rows, config };
    }, [data, series, metric]);

    const fmt = (v: number) => (metric === "cost" ? usd(v) : formatTokens(v));
    const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

    return (
        <div className="rounded-xl border bg-card p-5 shadow-xs">
            <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-sm font-medium">Daily {metric === "cost" ? "spend" : "tokens"}</h2>
                    <p className="text-xs text-muted-foreground">By model, UTC days</p>
                </div>
                <div className="flex rounded-lg bg-muted p-[3px]">
                    {(["cost", "tokens"] as const).map((m) => (
                        <button
                            key={m}
                            onClick={() => setMetric(m)}
                            className={cn("rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground", metric === m && "bg-background text-foreground shadow-sm dark:bg-input/30")}
                        >
                            {m === "cost" ? "Cost" : "Tokens"}
                        </button>
                    ))}
                </div>
            </div>
            {rows.length === 0 ? (
                <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">No requests in this range.</div>
            ) : (
                <ChartContainer config={config} className="aspect-auto h-72 w-full">
                    <BarChart data={rows} margin={{ left: 4, right: 4, top: 8 }} barCategoryGap="22%">
                        <CartesianGrid vertical={false} strokeDasharray="0" className="stroke-border/60" />
                        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={dayLabel} />
                        <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v) => fmt(Number(v))} />
                        <ChartTooltip
                            cursor={{ className: "fill-muted/60" }}
                            content={
                                <ChartTooltipContent
                                    labelFormatter={(_, p) => (p?.[0]?.payload?.day ? dayLabel(String(p[0].payload.day)) : "")}
                                    formatter={(value, name, item) => (
                                        <div className="flex w-full items-center gap-2">
                                            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: item.color }} />
                                            <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                                            <span className="ml-auto font-mono font-medium text-foreground tabular-nums">{fmt(Number(value))}</span>
                                        </div>
                                    )}
                                />
                            }
                        />
                        {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
                        {series.map((s, i) => (
                            <Bar
                                key={s.name}
                                dataKey={`s${i}`}
                                stackId="a"
                                fill={`var(--color-s${i})`}
                                maxBarSize={24}
                                // a surface-colored gap between stacked segments; only the top end is rounded
                                stroke="var(--card)"
                                strokeWidth={2}
                                radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
                            />
                        ))}
                    </BarChart>
                </ChartContainer>
            )}
        </div>
    );
}
