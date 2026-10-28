import "server-only";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { chapter, novel, providerKey, termChange } from "@/db/schema";

// Correlated subqueries spell out their tables: in a one-table select Drizzle leaves columns
// unqualified, and "novel_id" = "id" would then compare two columns of the inner table.
const countChapters = (where = "") =>
    sql<number>`(select count(*) from chapter c where c.novel_id = "novel"."id"${sql.raw(where ? ` and ${where}` : "")})::int`;

const chapterCounts = {
    total: countChapters(),
    done: countChapters("c.status = 'done'"),
    failed: countChapters("c.status = 'failed'"),
    queued: countChapters("c.status in ('queued', 'translating')"),
    skipped: countChapters("c.status = 'skipped'"),
    /** Terms with pending proposals (several proposals for one term are decided together). */
    pending: sql<number>`(select count(distinct (tc.term_id, tc.field)) from term_change tc where tc.novel_id = "novel"."id" and tc.status = 'pending')::int`,
    terms: sql<number>`(select count(*) from term t where t.novel_id = "novel"."id")::int`,
};

export async function listNovels() {
    return db
        .select({
            id: novel.id,
            title: novel.title,
            originalTitle: novel.originalTitle,
            status: novel.status,
            statusMessage: novel.statusMessage,
            targetLanguage: novel.targetLanguage,
            model: novel.model,
            inputTokens: novel.inputTokens,
            outputTokens: novel.outputTokens,
            updatedAt: novel.updatedAt,
            ...chapterCounts,
        })
        .from(novel)
        .orderBy(desc(novel.updatedAt));
}
export type NovelListItem = Awaited<ReturnType<typeof listNovels>>[number];

export async function getNovel(id: number) {
    if (!Number.isInteger(id)) notFound();
    const [row] = await db
        .select({ novel, key: providerKey, ...chapterCounts })
        .from(novel)
        .leftJoin(providerKey, eq(providerKey.id, novel.providerKeyId))
        .where(eq(novel.id, id));
    if (!row) notFound();
    return row;
}
export type NovelDetails = Awaited<ReturnType<typeof getNovel>>;

export async function pendingDecisionCount(novelId?: number): Promise<number> {
    const rows = await db
        .select({ termId: termChange.termId, field: termChange.field })
        .from(termChange)
        .where(and(eq(termChange.status, "pending"), novelId ? eq(termChange.novelId, novelId) : undefined))
        .groupBy(termChange.termId, termChange.field);
    return rows.length;
}

export async function listKeys() {
    return db
        .select({
            id: providerKey.id,
            name: providerKey.name,
            provider: providerKey.provider,
            baseURL: providerKey.baseURL,
            hint: providerKey.hint,
            createdAt: providerKey.createdAt,
            novels: sql<number>`(select count(*) from novel n where n.provider_key_id = "provider_key"."id")::int`,
        })
        .from(providerKey)
        .orderBy(asc(providerKey.name));
}
export type KeyListItem = Awaited<ReturnType<typeof listKeys>>[number];

export async function chapterIndexRange(novelId: number) {
    const [r] = await db
        .select({ min: sql<number | null>`min(${chapter.index})`, max: sql<number | null>`max(${chapter.index})`, n: count() })
        .from(chapter)
        .where(eq(chapter.novelId, novelId));
    return r;
}
