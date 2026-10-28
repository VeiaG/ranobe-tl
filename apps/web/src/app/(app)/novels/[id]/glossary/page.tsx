import { and, eq, sql } from "drizzle-orm";
import { genderAt } from "@ranobe-tl/core";
import { GlossaryTable } from "@/components/novel/glossary-table";
import { db } from "@/db";
import { termChange } from "@/db/schema";
import { PgGlossaryStore } from "@/server/glossary-store";
import { getNovel } from "@/server/queries";

export default async function GlossaryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string }> }) {
    const id = Number((await params).id);
    const { q } = await searchParams;
    await getNovel(id);
    const [terms, pending] = await Promise.all([
        new PgGlossaryStore(db, id).allTerms(),
        db
            .select({ termId: termChange.termId, n: sql<number>`count(*)::int` })
            .from(termChange)
            .where(and(eq(termChange.novelId, id), eq(termChange.status, "pending")))
            .groupBy(termChange.termId),
    ]);
    const pendingBy = new Map(pending.map((p) => [p.termId, p.n]));
    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            <GlossaryTable
                novelId={id}
                initialQuery={q ?? ""}
                terms={terms.map((t) => ({
                    id: t.id,
                    source: t.source,
                    target: t.target,
                    type: t.type,
                    note: t.note,
                    locked: t.locked,
                    firstChapter: t.firstChapter,
                    genders: t.genders,
                    gender: t.type === "person" ? (genderAt(t, Number.MAX_SAFE_INTEGER) ?? "unknown") : null,
                    pending: pendingBy.get(t.id) ?? 0,
                }))}
            />
        </div>
    );
}
