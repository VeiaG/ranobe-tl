import { NovelLive } from "@/components/novel/live";
import { LiveStatus } from "@/components/novel/live-status";
import { NovelTabs } from "@/components/novel/novel-tabs";
import { RunControls } from "@/components/novel/run-controls";
import { chapterIndexRange, getNovel } from "@/server/queries";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
    const { novel } = await getNovel(Number((await params).id));
    return { title: novel.title };
}

export default async function NovelLayout({ params, children }: { params: Promise<{ id: string }>; children: React.ReactNode }) {
    const id = Number((await params).id);
    const [d, range] = await Promise.all([getNovel(id), chapterIndexRange(id)]);
    const n = d.novel;
    const untranslated = d.total - d.done - d.failed - d.skipped - d.queued;
    return (
        <NovelLive novelId={n.id} initialStatus={n.status} initialMessage={n.statusMessage}>
            <div className="border-b bg-background">
                <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 lg:px-8 lg:pt-8">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-2">
                            <div>
                                <h1 className="truncate text-2xl font-semibold tracking-tight">{n.title}</h1>
                                <p className="truncate text-sm text-muted-foreground">
                                    {n.originalTitle ? `${n.originalTitle} · ` : ""}
                                    {n.sourceLanguage} → {n.targetLanguage}
                                </p>
                            </div>
                            <LiveStatus />
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                            <RunControls
                                novelId={n.id}
                                hasKey={!!d.key}
                                counts={{
                                    total: d.total,
                                    done: d.done,
                                    failed: d.failed,
                                    queued: d.queued,
                                    untranslated,
                                    minIndex: range.min ?? 1,
                                    maxIndex: range.max ?? 1,
                                }}
                            />
                        </div>
                    </div>
                    <div className="mt-6">
                        <NovelTabs novelId={n.id} counts={{ chapters: d.total, terms: d.terms, pending: d.pending }} />
                    </div>
                </div>
            </div>
            {children}
        </NovelLive>
    );
}
