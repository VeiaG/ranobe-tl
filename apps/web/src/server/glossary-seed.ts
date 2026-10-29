import { and, eq } from "drizzle-orm";
import { normalizeTerm } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { ignoredTerm, novel, term, termChange, termGender } from "@/db/schema";
import { glossaryJson } from "./storage/folder";
import { parseGlossaryJson, readCliDatabase, type Glossary } from "./storage/import";

/** A glossary file: this app's glossary.json, a plain array, the CLI's flat meta.json, or its glossary.db. */
export async function glossaryFromFile(name: string, data: Uint8Array): Promise<Glossary> {
    if (/\.(db|sqlite3?)$/i.test(name) || new TextDecoder().decode(data.slice(0, 15)) === "SQLite format 3") {
        return (await readCliDatabase(data)).glossary;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(data).replace(/^﻿/, ""));
    } catch {
        throw new Error("The file is neither JSON nor a glossary.db");
    }
    const g = parseGlossaryJson(parsed);
    if (!g.terms.length) throw new Error("No terms found in the file");
    return g;
}

export async function glossaryOfNovel(db: DB, novelId: number): Promise<Glossary> {
    return parseGlossaryJson(JSON.parse(await glossaryJson(db, novelId)));
}

/**
 * Prepares a glossary of an earlier part for the next one: the last known gender holds from its first
 * chapter, first-seen chapters and open questions stay behind, rejected proposals and "not a term"
 * sources come along so they are not asked about again.
 */
export function forSequel(g: Glossary): Glossary {
    return {
        terms: g.terms.map((t) => ({
            ...t,
            firstChapter: null,
            genders: t.genders.length ? [{ fromChapter: 1, gender: t.genders[t.genders.length - 1].gender }] : [],
        })),
        changes: g.changes.filter((c) => c.status === "rejected").map((c) => ({ ...c, chapter: null })),
        ignored: g.ignored,
    };
}

export interface MergeResult {
    added: number;
    existing: number;
    rejected: number;
    ignored: number;
}

/** Adds the terms the novel does not have yet; what it already has always wins. */
export async function mergeGlossary(db: DB, novelId: number, g: Glossary): Promise<MergeResult> {
    return db.transaction(async (tx) => {
        const have = new Map(
            (await tx.select({ id: term.id, norm: term.sourceNorm }).from(term).where(eq(term.novelId, novelId))).map((t) => [t.norm, t.id])
        );
        const result: MergeResult = { added: 0, existing: 0, rejected: 0, ignored: 0 };
        for (const t of g.terms) {
            const norm = normalizeTerm(t.source);
            if (have.has(norm)) {
                result.existing++;
                continue;
            }
            const [row] = await tx
                .insert(term)
                .values({ novelId, source: t.source, sourceNorm: norm, target: t.target, type: t.type, note: t.note, locked: t.locked, firstChapter: t.firstChapter })
                .returning({ id: term.id });
            have.set(norm, row.id);
            if (t.genders.length) await tx.insert(termGender).values(t.genders.map((x) => ({ termId: row.id, ...x })));
            result.added++;
        }
        for (const c of g.changes) {
            const termId = have.get(normalizeTerm(c.source));
            if (!termId) continue;
            const dup = await tx
                .select({ id: termChange.id })
                .from(termChange)
                .where(and(eq(termChange.termId, termId), eq(termChange.field, c.field), eq(termChange.newValue, c.newValue), eq(termChange.status, c.status)))
                .limit(1);
            if (dup.length) continue;
            await tx.insert(termChange).values({
                novelId,
                termId,
                field: c.field,
                oldValue: c.oldValue,
                newValue: c.newValue,
                chapter: c.chapter,
                status: c.status,
                reason: c.reason || "from an earlier part",
                evidence: c.evidence,
                decidedAt: c.status === "pending" ? null : new Date(),
            });
            if (c.status === "rejected") result.rejected++;
        }
        for (const source of g.ignored) {
            const rows = await tx
                .insert(ignoredTerm)
                .values({ novelId, sourceNorm: normalizeTerm(source), source })
                .onConflictDoNothing()
                .returning({ s: ignoredTerm.sourceNorm });
            result.ignored += rows.length;
        }
        return result;
    });
}

export function describeMerge(r: MergeResult, from: string): string {
    const extra = [r.existing && `${r.existing} already there`, r.rejected && `${r.rejected} rejected proposals`, r.ignored && `${r.ignored} "not a term"`].filter(Boolean);
    return `glossary from ${from}: ${r.added} terms added${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

export async function novelTitle(db: DB, id: number): Promise<string | undefined> {
    return (await db.select({ title: novel.title }).from(novel).where(eq(novel.id, id)))[0]?.title;
}
