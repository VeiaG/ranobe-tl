import { createHash } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { chapter, ignoredTerm, novel, providerKey, term, termChange } from "@/db/schema";
import { novelSettings } from "../novel-config";
import { PgGlossaryStore } from "../glossary-store";

/**
 * A novel as a plain folder, the same layout the CLI used, so it can be read by hand,
 * continued with the CLI, or imported back:
 *
 *   novel.json              CLI config + a "ranobeTl" block with what only the app knows
 *   glossary.json           terms (with gender history), past decisions, ignored sources
 *   translation/00001.json  { content, title }
 *   chapters/00001.txt      source, title on the first line
 */
export const GLOSSARY_FORMAT = "ranobe-tl/glossary@1";

type Novel = typeof novel.$inferSelect;

export function slugify(title: string): string {
    return (
        title
            .normalize("NFKC")
            .toLowerCase()
            .replace(/['’`]/g, "")
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80) || "novel"
    );
}

export function sha1(text: string): string {
    return createHash("sha1").update(text).digest("hex");
}

export function chapterFileName(index: number, maxIndex: number): string {
    return String(index).padStart(Math.max(5, String(maxIndex).length), "0");
}

export function translationFile(c: { title: string | null; content: string | null }): string {
    return JSON.stringify({ content: c.content ?? "", title: c.title ?? "" }, null, 2);
}

export async function novelJson(db: DB, n: Novel): Promise<string> {
    const [range] = await db
        .select({ start: sql<number | null>`min(${chapter.index})`, end: sql<number | null>`max(${chapter.index})` })
        .from(chapter)
        .where(eq(chapter.novelId, n.id));
    const key = n.providerKeyId ? (await db.select().from(providerKey).where(eq(providerKey.id, n.providerKeyId)))[0] : undefined;
    const config = {
        range: { start: range.start ?? 1, end: range.end ?? 1 },
        ...(key ? { provider: key.provider } : {}),
        ...(n.model ? { model: n.model } : {}),
        ...(key?.baseURL ? { baseURL: key.baseURL } : {}),
        sourceLanguage: n.sourceLanguage,
        targetLanguage: n.targetLanguage,
        novel: { title: n.originalTitle || n.title, synopsis: n.synopsis },
        ...novelSettings(n),
        ranobeTl: {
            title: n.title,
            originalTitle: n.originalTitle,
            decisionMode: n.decisionMode,
            pipeline: n.pipeline,
            askNew: n.askNew,
        },
    };
    return JSON.stringify(config, null, 2);
}

export async function glossaryJson(db: DB, novelId: number): Promise<string> {
    const terms = await new PgGlossaryStore(db, novelId).allTerms();
    const [changes, ignored] = await Promise.all([
        db
            .select({ change: termChange, source: term.source })
            .from(termChange)
            .innerJoin(term, eq(term.id, termChange.termId))
            .where(and(eq(termChange.novelId, novelId), ne(termChange.field, "new")))
            .orderBy(asc(termChange.id)),
        db.select({ source: ignoredTerm.source }).from(ignoredTerm).where(eq(ignoredTerm.novelId, novelId)).orderBy(asc(ignoredTerm.source)),
    ]);
    return JSON.stringify(
        {
            format: GLOSSARY_FORMAT,
            terms: terms.map((t) => ({
                source: t.source,
                target: t.target,
                type: t.type,
                note: t.note || undefined,
                locked: t.locked || undefined,
                firstChapter: t.firstChapter ?? undefined,
                gender: t.genders.at(-1)?.gender,
                genders: t.genders.length > 1 ? t.genders : undefined,
            })),
            // decisions are kept so that a rejected proposal is not asked about again after a restore
            changes: changes.map(({ change: c, source }) => ({
                source,
                field: c.field,
                oldValue: c.oldValue,
                newValue: c.newValue,
                chapter: c.chapter ?? undefined,
                status: c.status,
                reason: c.reason || undefined,
                evidence: c.evidence || undefined,
            })),
            ignored: ignored.map((i) => i.source),
        },
        null,
        2
    );
}

/** The whole folder in memory, for the zip export. */
export async function novelFolder(db: DB, novelId: number, includeSources = true): Promise<Map<string, string>> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n) throw new Error("novel not found");
    const files = new Map<string, string>();
    files.set("novel.json", await novelJson(db, n));
    files.set("glossary.json", await glossaryJson(db, novelId));
    const rows = await db
        .select({ index: chapter.index, status: chapter.status, title: chapter.title, content: chapter.content, source: chapter.source })
        .from(chapter)
        .where(eq(chapter.novelId, novelId))
        .orderBy(asc(chapter.index));
    const max = rows.at(-1)?.index ?? 1;
    for (const r of rows) {
        const name = chapterFileName(r.index, max);
        if (r.status === "done" && r.content) files.set(`translation/${name}.json`, translationFile(r));
        if (includeSources && r.source) files.set(`chapters/${name}.txt`, r.source);
    }
    return files;
}
