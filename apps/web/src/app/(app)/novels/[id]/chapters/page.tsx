import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { ChaptersTable } from "@/components/novel/chapters-table";
import { db } from "@/db";
import { CHAPTER_STATUSES, chapter, type ChapterStatus } from "@/db/schema";
import { getNovel } from "@/server/queries";

const PAGE_SIZE = 100;

export default async function ChaptersPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; q?: string; page?: string; upload?: string }> }) {
    const id = Number((await params).id);
    const sp = await searchParams;
    const { novel } = await getNovel(id);
    const status = (CHAPTER_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as ChapterStatus) : undefined;
    const q = sp.q?.trim();
    const page = Math.max(1, Number(sp.page) || 1);

    const where = and(
        eq(chapter.novelId, id),
        status ? (status === "queued" ? sql`${chapter.status} in ('queued', 'translating')` : eq(chapter.status, status)) : undefined,
        q ? (/^\d+$/.test(q) ? eq(chapter.index, Number(q)) : or(ilike(chapter.sourceTitle, `%${q}%`), ilike(chapter.title, `%${q}%`))) : undefined
    );
    const [rows, [{ total }], byStatus] = await Promise.all([
        db
            .select({
                index: chapter.index,
                sourceTitle: chapter.sourceTitle,
                title: chapter.title,
                status: chapter.status,
                attempts: chapter.attempts,
                ratio: chapter.ratio,
                error: chapter.error,
                chars: sql<number>`length(${chapter.source})::int`,
                tokens: sql<number>`(${chapter.inputTokens} + ${chapter.outputTokens})::int`,
                duration: chapter.duration,
                translatedAt: chapter.translatedAt,
            })
            .from(chapter)
            .where(where)
            .orderBy(asc(chapter.index))
            .limit(PAGE_SIZE)
            .offset((page - 1) * PAGE_SIZE),
        db.select({ total: count() }).from(chapter).where(where),
        db
            .select({ status: chapter.status, n: count() })
            .from(chapter)
            .where(eq(chapter.novelId, id))
            .groupBy(chapter.status),
    ]);
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Partial<Record<ChapterStatus, number>>;

    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            <ChaptersTable
                novelId={id}
                running={novel.status === "running"}
                rows={rows.map((r) => ({ ...r, translatedAt: r.translatedAt?.toISOString() ?? null }))}
                total={total}
                page={page}
                pageSize={PAGE_SIZE}
                status={status}
                q={q ?? ""}
                counts={{
                    all: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0),
                    new: counts.new ?? 0,
                    queued: (counts.queued ?? 0) + (counts.translating ?? 0),
                    done: counts.done ?? 0,
                    failed: counts.failed ?? 0,
                    skipped: counts.skipped ?? 0,
                }}
                openUpload={sp.upload === "1"}
            />
        </div>
    );
}
