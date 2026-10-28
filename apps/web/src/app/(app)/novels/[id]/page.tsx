import Link from "next/link";
import { and, avg, desc, eq } from "drizzle-orm";
import { ArrowRight, BookOpenText, Clock, Coins, Cpu, Inbox, Library, Upload } from "lucide-react";
import { PROVIDER_DEFAULTS, type Provider } from "@ranobe-tl/core";
import { ActivityFeed } from "@/components/novel/activity-feed";
import { StatCard } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { chapter } from "@/db/schema";
import { formatNumber, formatTokens, timeAgo } from "@/lib/utils";
import { getNovel } from "@/server/queries";

export default async function NovelOverview({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);
    const d = await getNovel(id);
    const n = d.novel;
    const [recent, [speed]] = await Promise.all([
        db
            .select({ index: chapter.index, title: chapter.title, sourceTitle: chapter.sourceTitle, translatedAt: chapter.translatedAt })
            .from(chapter)
            .where(and(eq(chapter.novelId, id), eq(chapter.status, "done")))
            .orderBy(desc(chapter.translatedAt))
            .limit(6),
        db
            .select({ seconds: avg(chapter.duration) })
            .from(chapter)
            .where(and(eq(chapter.novelId, id), eq(chapter.status, "done"))),
    ]);
    const untranslated = d.total - d.done - d.failed - d.skipped - d.queued;
    const segments = [
        { label: "Done", value: d.done, className: "bg-success" },
        { label: "Queued", value: d.queued, className: "bg-info" },
        { label: "Failed", value: d.failed, className: "bg-destructive" },
        { label: "Skipped", value: d.skipped, className: "bg-warning" },
        { label: "Not started", value: untranslated, className: "bg-muted-foreground/20" },
    ];
    const pct = d.total ? (d.done / d.total) * 100 : 0;
    const secs = speed?.seconds ? Number(speed.seconds) : 0;
    const etaHours = secs && d.queued ? (secs * d.queued) / 3600 : 0;
    const model = n.model || (d.key ? PROVIDER_DEFAULTS[d.key.provider as Provider]?.model : "") || "—";

    return (
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[1fr_22rem] lg:px-8">
            <div className="grid content-start gap-6">
                {d.pending > 0 && (
                    <Link
                        href={`/novels/${id}/decisions`}
                        className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/8 p-4 transition-colors hover:bg-warning/12"
                    >
                        <div className="flex size-9 items-center justify-center rounded-lg bg-warning/20 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]">
                            <Inbox className="size-4" />
                        </div>
                        <div className="flex-1 text-sm">
                            <div className="font-medium">
                                {d.pending} glossary {d.pending === 1 ? "term waits" : "terms wait"} for a decision
                            </div>
                            <div className="text-muted-foreground">
                                {n.status === "waiting" ? "The translation is paused until you decide." : "The model suggested changing terms that are already in the glossary."}
                            </div>
                        </div>
                        <ArrowRight className="size-4 text-muted-foreground" />
                    </Link>
                )}

                <div className="rounded-xl border bg-card p-5 shadow-xs">
                    <div className="flex items-end justify-between gap-4">
                        <div>
                            <div className="text-xs font-medium text-muted-foreground">Progress</div>
                            <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                                {pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}
                                <span className="text-lg text-muted-foreground">%</span>
                            </div>
                        </div>
                        <div className="text-right text-sm text-muted-foreground">
                            <span className="font-medium text-foreground tabular-nums">{formatNumber(d.done)}</span> of {formatNumber(d.total)} chapters
                            {etaHours > 0 && <div className="text-xs">≈ {etaHours < 1 ? `${Math.max(1, Math.round(etaHours * 60))} min` : `${etaHours.toFixed(1)} h`} left for the queue</div>}
                        </div>
                    </div>
                    <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-muted">
                        {segments.map((s) =>
                            s.value > 0 && d.total ? <div key={s.label} className={s.className} style={{ width: `${(s.value / d.total) * 100}%` }} title={`${s.label}: ${s.value}`} /> : null
                        )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
                        {segments.map((s) => (
                            <span key={s.label} className="flex items-center gap-1.5">
                                <span className={`size-2 rounded-full ${s.className}`} />
                                {s.label} <span className="font-medium text-foreground tabular-nums">{formatNumber(s.value)}</span>
                            </span>
                        ))}
                    </div>
                    {d.total === 0 && (
                        <div className="mt-5 flex items-center justify-between gap-3 rounded-lg bg-muted/50 p-3 text-sm">
                            <span className="text-muted-foreground">No chapters yet. Upload .txt files, a zip, or paste text.</span>
                            <Button size="sm" nativeButton={false} render={<Link href={`/novels/${id}/chapters?upload=1`} />}>
                                    <Upload />
                                    Upload
                                </Button>
                        </div>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <StatCard label="Model" value={<span className="block truncate font-mono text-base">{model}</span>} hint={d.key ? `${d.key.name} ···${d.key.hint}` : "no key"} icon={Cpu} />
                    <StatCard label="Glossary" value={formatNumber(d.terms)} hint="terms" icon={Library} />
                    <StatCard
                        label="Tokens"
                        value={formatTokens(n.inputTokens + n.outputTokens)}
                        hint={`${formatTokens(n.inputTokens)} in${n.cachedTokens ? ` (${formatTokens(n.cachedTokens)} cached)` : ""} · ${formatTokens(n.outputTokens)} out`}
                        icon={Coins}
                    />
                    <StatCard label="Per chapter" value={secs ? `${Math.round(secs)}s` : "—"} hint="average time" icon={Clock} />
                </div>

                <div className="rounded-xl border bg-card shadow-xs">
                    <div className="flex items-center justify-between border-b px-4 py-3">
                        <h2 className="text-sm font-medium">Recently translated</h2>
                        <Link href={`/novels/${id}/chapters`} className="text-xs text-muted-foreground hover:text-foreground">
                            All chapters →
                        </Link>
                    </div>
                    {recent.length === 0 ? (
                        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Translated chapters will show up here.</p>
                    ) : (
                        <ul className="divide-y">
                            {recent.map((c) => (
                                <li key={c.index}>
                                    <Link href={`/novels/${id}/chapters/${c.index}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/40">
                                        <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">#{c.index}</span>
                                        <span className="min-w-0 flex-1 truncate">{c.title || c.sourceTitle}</span>
                                        <span className="hidden truncate text-xs text-muted-foreground sm:block sm:max-w-56">{c.sourceTitle}</span>
                                        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{timeAgo(c.translatedAt)}</span>
                                        <BookOpenText className="size-4 shrink-0 text-muted-foreground" />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
            <ActivityFeed novelId={id} className="lg:sticky lg:top-6 lg:self-start" />
        </div>
    );
}
