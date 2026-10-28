import Link from "next/link";
import { ArrowRight, BookOpen, CircleAlert, Coins, Inbox, KeyRound, Languages, Plus, Sparkles } from "lucide-react";
import { EmptyState, Page, PageHeader, StatCard } from "@/components/page-header";
import { NovelStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatNumber, formatTokens, timeAgo } from "@/lib/utils";
import { listKeys, listNovels, pendingDecisionCount, type NovelListItem } from "@/server/queries";

export const metadata = { title: "Dashboard" };

export default async function Dashboard() {
    const [novels, pending, keys] = await Promise.all([listNovels(), pendingDecisionCount(), listKeys()]);
    const totals = novels.reduce(
        (a, n) => ({ done: a.done + n.done, total: a.total + n.total, tokens: a.tokens + n.inputTokens + n.outputTokens, running: a.running + (n.status === "running" ? 1 : 0) }),
        { done: 0, total: 0, tokens: 0, running: 0 }
    );

    return (
        <Page>
            <PageHeader
                title="Dashboard"
                description="Everything your translators are working on."
                actions={
                    <Button asChild>
                        <Link href="/novels/new">
                            <Plus />
                            New novel
                        </Link>
                    </Button>
                }
            />

            {!keys.length && (
                <div className="mt-6 flex flex-col gap-3 rounded-xl border border-brand/25 bg-brand/5 p-4 sm:flex-row sm:items-center">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand">
                        <KeyRound className="size-4" />
                    </div>
                    <div className="flex-1 text-sm">
                        <div className="font-medium">Add an API key to start translating</div>
                        <div className="text-muted-foreground">OpenAI, Anthropic or Google. Keys are stored encrypted and can be shared between novels.</div>
                    </div>
                    <Button asChild variant="outline" size="sm">
                        <Link href="/settings?tab=keys">
                            Add a key
                            <ArrowRight />
                        </Link>
                    </Button>
                </div>
            )}

            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Novels" value={novels.length} hint={totals.running ? `${totals.running} translating now` : "none running"} icon={BookOpen} />
                <StatCard label="Chapters translated" value={formatNumber(totals.done)} hint={`of ${formatNumber(totals.total)} uploaded`} icon={Languages} />
                <StatCard
                    label="Decisions waiting"
                    value={pending}
                    hint={pending ? <Link href="/decisions" className="text-brand hover:underline">Review now →</Link> : "all clear"}
                    icon={Inbox}
                />
                <StatCard label="Tokens used" value={formatTokens(totals.tokens)} hint="input + output, all novels" icon={Coins} />
            </div>

            <div className="mt-8">
                <h2 className="mb-3 text-sm font-medium text-muted-foreground">Novels</h2>
                {novels.length === 0 ? (
                    <EmptyState icon={Sparkles} title="No novels yet" description="Create a novel, upload its chapters and let the translator work through them in order.">
                        <Button asChild>
                            <Link href="/novels/new">
                                <Plus />
                                Create your first novel
                            </Link>
                        </Button>
                    </EmptyState>
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {novels.map((n) => (
                            <NovelCard key={n.id} n={n} />
                        ))}
                    </div>
                )}
            </div>
        </Page>
    );
}

function NovelCard({ n }: { n: NovelListItem }) {
    const pct = n.total ? (n.done / n.total) * 100 : 0;
    return (
        <Link href={`/novels/${n.id}`} className="group flex flex-col rounded-xl border bg-card p-4 shadow-xs transition-all hover:border-foreground/15 hover:shadow-sm">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate font-medium group-hover:text-brand">{n.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{n.originalTitle || `→ ${n.targetLanguage}`}</div>
                </div>
                <NovelStatusBadge status={n.status} />
            </div>
            <div className="mt-5 flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">
                    <span className="text-base font-semibold text-foreground tabular-nums">{formatNumber(n.done)}</span> / {formatNumber(n.total)} chapters
                </span>
                <span className="tabular-nums text-muted-foreground">{pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}%</span>
            </div>
            <Progress value={pct} className="mt-2" />
            <div className="mt-3 flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {n.pending > 0 && (
                    <Badge variant="warning">
                        <Inbox />
                        {n.pending} to decide
                    </Badge>
                )}
                {n.failed > 0 && (
                    <Badge variant="destructive">
                        <CircleAlert />
                        {n.failed} failed
                    </Badge>
                )}
                {n.queued > 0 && n.status !== "running" && <Badge variant="info">{n.queued} queued</Badge>}
                <span className="ml-auto">{n.status === "running" && n.statusMessage ? n.statusMessage : `updated ${timeAgo(n.updatedAt)}`}</span>
            </div>
        </Link>
    );
}
