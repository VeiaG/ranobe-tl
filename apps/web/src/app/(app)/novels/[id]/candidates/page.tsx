import { notFound } from "next/navigation";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { CandidatesPanel } from "@/components/novel/candidates-panel";
import { db } from "@/db";
import { batchJob, chapter } from "@/db/schema";
import { formatNumber, timeAgo } from "@/lib/utils";
import { candidateGroups } from "@/server/batch/merge";
import { getNovel } from "@/server/queries";

export default async function CandidatesPage({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);
    const d = await getNovel(id);
    if (d.novel.pipeline !== "batch") notFound();
    const [groups, [extracted], jobs] = await Promise.all([
        candidateGroups(db, id),
        db
            .select({ n: sql<number>`count(*)::int` })
            .from(chapter)
            .where(and(eq(chapter.novelId, id), isNotNull(chapter.extractedAt))),
        db.select().from(batchJob).where(eq(batchJob.novelId, id)).orderBy(desc(batchJob.id)).limit(5),
    ]);
    return (
        <div className="mx-auto grid w-full max-w-4xl gap-4 px-4 py-6 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 rounded-xl border bg-card px-5 py-3.5 text-sm shadow-xs">
                <span>
                    Terms extracted from <span className="font-medium tabular-nums">{formatNumber(extracted.n)}</span> of {formatNumber(d.total)} chapters ·{" "}
                    <span className="font-medium tabular-nums">{formatNumber(d.terms)}</span> in the glossary
                </span>
                {jobs.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                        last batch: {jobs[0].kind === "extract" ? "extraction" : "translation"}, {jobs[0].requests} requests, {jobs[0].status.replace("_", " ")}, {timeAgo(jobs[0].createdAt)}
                    </span>
                )}
            </div>
            <CandidatesPanel novelId={id} groups={groups} />
        </div>
    );
}
