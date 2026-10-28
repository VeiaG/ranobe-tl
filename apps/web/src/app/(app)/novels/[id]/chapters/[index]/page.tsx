import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Glossary, genderAt } from "@ranobe-tl/core";
import { Reader } from "@/components/novel/reader";
import { db } from "@/db";
import { chapter, chapterVersion, exchange } from "@/db/schema";
import { PgGlossaryStore } from "@/server/glossary-store";
import { getNovel } from "@/server/queries";

export async function generateMetadata({ params }: { params: Promise<{ id: string; index: string }> }) {
    const { id, index } = await params;
    const [c] = await db
        .select({ title: chapter.title, sourceTitle: chapter.sourceTitle })
        .from(chapter)
        .where(and(eq(chapter.novelId, Number(id)), eq(chapter.index, Number(index))));
    return { title: c ? c.title || c.sourceTitle || `Chapter ${index}` : "Chapter" };
}

export default async function ChapterPage({ params }: { params: Promise<{ id: string; index: string }> }) {
    const { id: rawId, index: rawIndex } = await params;
    const id = Number(rawId);
    const index = Number(rawIndex);
    const { novel } = await getNovel(id);
    const [c] = await db
        .select()
        .from(chapter)
        .where(and(eq(chapter.novelId, id), eq(chapter.index, index)));
    if (!c) notFound();

    const [[prev], [next], exchanges, versions] = await Promise.all([
        db.select({ index: chapter.index }).from(chapter).where(and(eq(chapter.novelId, id), lt(chapter.index, index))).orderBy(desc(chapter.index)).limit(1),
        db.select({ index: chapter.index }).from(chapter).where(and(eq(chapter.novelId, id), gt(chapter.index, index))).orderBy(asc(chapter.index)).limit(1),
        db
            .select({ id: exchange.id, chunk: exchange.chunk, attempt: exchange.attempt, prompt: exchange.prompt, output: exchange.output, createdAt: exchange.createdAt })
            .from(exchange)
            .where(and(eq(exchange.novelId, id), eq(exchange.chapter, index)))
            .orderBy(asc(exchange.id)),
        db.select().from(chapterVersion).where(eq(chapterVersion.chapterId, c.id)).orderBy(desc(chapterVersion.id)),
    ]);

    const glossary = await Glossary.load(new PgGlossaryStore(db, id));
    const terms = glossary
        .relevant(c.source)
        .filter((t) => t.id > 0)
        .map((t) => ({ id: t.id, source: t.source, target: t.target, type: t.type, note: t.note, locked: t.locked, gender: t.type === "person" ? (genderAt(t, index) ?? null) : null }));

    return (
        <Reader
            novelId={id}
            novelTitle={novel.title}
            chapter={{
                index: c.index,
                status: c.status,
                source: c.source,
                sourceTitle: c.sourceTitle,
                title: c.title,
                content: c.content,
                error: c.error,
                model: c.model,
                attempts: c.attempts,
                ratio: c.ratio,
                tokens: c.inputTokens + c.outputTokens,
                duration: c.duration,
                translatedAt: c.translatedAt?.toISOString() ?? null,
            }}
            prev={prev?.index ?? null}
            next={next?.index ?? null}
            terms={terms}
            exchanges={exchanges.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }))}
            versions={versions.map((v) => ({
                id: v.id,
                title: v.title,
                content: v.content,
                model: v.model,
                replacedBy: v.replacedBy,
                translatedAt: v.translatedAt?.toISOString() ?? null,
                createdAt: v.createdAt.toISOString(),
            }))}
        />
    );
}
