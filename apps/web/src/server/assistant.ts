import "server-only";
import { and, asc, between, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import { chapter } from "@/db/schema";
import { escapeRegExp, makeSnippet } from "@/lib/text-replace";
import { keepVersion } from "./versions";

// The chat assistant of the Replace tab: searches translations and sources, reads chapters and
// proposes literal edits that the user confirms before anything is written.

const MAX_PATTERN = 300;

export const SearchInput = z.object({
    query: z.string().min(1).describe("Text to find, or a regular expression when regex is true"),
    regex: z.boolean().default(false).describe("JavaScript regex in unicode mode: \\p{L} matches any letter, \\b does not work with Cyrillic"),
    caseSensitive: z.boolean().default(false),
    from: z.number().int().optional().describe("First chapter to search"),
    to: z.number().int().optional().describe("Last chapter to search"),
    limit: z.number().int().min(1).max(200).default(60).describe("Matches to return; totals always count everything"),
});

export interface SearchHit {
    chapter: number;
    /** Where it was found: the translated title or text, or the source. */
    in: "title" | "text" | "source";
    snippet: string;
    /** The exact matched text, to copy into an edit. */
    match: string;
}

function buildSearch(input: z.infer<typeof SearchInput>): RegExp {
    if (input.query.length > MAX_PATTERN) throw new Error(`The query is too long (at most ${MAX_PATTERN} characters)`);
    try {
        return new RegExp(input.regex ? input.query : escapeRegExp(input.query), input.caseSensitive ? "gu" : "giu");
    } catch (error) {
        throw new Error(`Not a valid regular expression: ${error instanceof Error ? error.message : error}`);
    }
}

/** Searches the translated chapters (titles and text) or the sources. */
export async function search(db: DB, novelId: number, where: "translation" | "source", input: z.infer<typeof SearchInput>) {
    const regex = buildSearch(input);
    const rows = await db
        .select({ index: chapter.index, title: chapter.title, content: chapter.content, source: chapter.source })
        .from(chapter)
        .where(
            and(
                eq(chapter.novelId, novelId),
                where === "translation" ? eq(chapter.status, "done") : undefined,
                input.from !== undefined || input.to !== undefined ? between(chapter.index, input.from ?? 0, input.to ?? 1e9) : undefined
            )
        )
        .orderBy(asc(chapter.index));

    const hits: SearchHit[] = [];
    const chapters = new Set<number>();
    /** Distinct matched forms with their counts: shows every spelling and grammatical form at a glance. */
    const forms = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
        const fields: [SearchHit["in"], string][] = where === "translation" ? [["title", r.title ?? ""], ["text", r.content ?? ""]] : [["source", r.source]];
        for (const [field, text] of fields) {
            for (const m of text.matchAll(regex)) {
                if (!m[0]) continue;
                total++;
                chapters.add(r.index);
                forms.set(m[0], (forms.get(m[0]) ?? 0) + 1);
                if (hits.length < input.limit) hits.push({ chapter: r.index, in: field, match: m[0], snippet: makeSnippet(text, m.index, m[0].length, 80) });
            }
        }
    }
    return {
        totalMatches: total,
        chapters: [...chapters],
        forms: Object.fromEntries([...forms].sort((a, b) => b[1] - a[1]).slice(0, 50)),
        hits,
        truncated: total > hits.length,
    };
}

export const ReadInput = z.object({
    chapter: z.number().int(),
    part: z.enum(["translation", "source"]).default("translation"),
    offset: z.number().int().min(0).default(0).describe("Character to start from"),
    length: z.number().int().min(100).max(12000).default(4000),
});

export async function readChapter(db: DB, novelId: number, input: z.infer<typeof ReadInput>) {
    const [r] = await db
        .select({ title: chapter.title, sourceTitle: chapter.sourceTitle, content: chapter.content, source: chapter.source, status: chapter.status })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), eq(chapter.index, input.chapter)));
    if (!r) throw new Error(`There is no chapter ${input.chapter}`);
    const text = input.part === "source" ? r.source : (r.content ?? "");
    return {
        chapter: input.chapter,
        title: input.part === "source" ? r.sourceTitle : r.title,
        status: r.status,
        length: text.length,
        offset: input.offset,
        text: text.slice(input.offset, input.offset + input.length),
    };
}

export const Edit = z.object({
    chapter: z.number().int(),
    field: z.enum(["title", "text"]).default("text"),
    find: z.string().min(1).describe("Exact text as it is now in the chapter, copied from a search hit or the chapter text"),
    replace: z.string().describe("What it becomes; may be empty"),
});
export type Edit = z.infer<typeof Edit>;

export const ProposeInput = z.object({
    summary: z.string().describe("One sentence for the user: what these edits change"),
    edits: z.array(Edit).min(1).max(100),
});

export interface EditPreview extends Edit {
    /** How many times `find` occurs in that field; every occurrence is replaced. */
    occurrences: number;
    before: string;
    after: string;
    error: string | null;
}

const count = (text: string, find: string) => (find ? text.split(find).length - 1 : 0);

/** Checks proposed edits against the current text and shows them in context; nothing is written. */
export async function previewEdits(db: DB, novelId: number, edits: Edit[]): Promise<EditPreview[]> {
    const rows = await db
        .select({ index: chapter.index, title: chapter.title, content: chapter.content, status: chapter.status })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), inArray(chapter.index, [...new Set(edits.map((e) => e.chapter)), -1])));
    const byIndex = new Map(rows.map((r) => [r.index, r]));
    return edits.map((e) => {
        const r = byIndex.get(e.chapter);
        const empty = { ...e, occurrences: 0, before: "", after: "" };
        if (!r) return { ...empty, error: `There is no chapter ${e.chapter}` };
        if (r.status !== "done") return { ...empty, error: `Chapter ${e.chapter} is not translated` };
        const text = (e.field === "title" ? r.title : r.content) ?? "";
        const at = text.indexOf(e.find);
        if (at < 0) return { ...empty, error: "This text is not in the chapter (copy it exactly from a search hit)" };
        if (e.find === e.replace) return { ...empty, error: "The replacement is the same text" };
        return {
            ...e,
            occurrences: count(text, e.find),
            before: makeSnippet(text, at, e.find.length, 60),
            after: makeSnippet(text.slice(0, at) + e.replace + text.slice(at + e.find.length), at, e.replace.length, 60),
            error: null,
        };
    });
}

export interface ApplyResult {
    applied: { chapter: number; field: Edit["field"]; find: string; occurrences: number }[];
    failed: { chapter: number; field: Edit["field"]; find: string; reason: string }[];
}

/** Writes confirmed edits, in order; each chapter's previous text goes to its history once. */
export async function applyEdits(db: DB, novelId: number, edits: Edit[]): Promise<ApplyResult> {
    const result: ApplyResult = { applied: [], failed: [] };
    const indexes = [...new Set(edits.map((e) => e.chapter))];
    for (const index of indexes) {
        const [c] = await db
            .select()
            .from(chapter)
            .where(and(eq(chapter.novelId, novelId), eq(chapter.index, index)));
        const mine = edits.filter((e) => e.chapter === index);
        if (!c || c.status !== "done") {
            for (const e of mine) result.failed.push({ chapter: index, field: e.field, find: e.find, reason: "the chapter is not translated any more" });
            continue;
        }
        let title = c.title ?? "";
        let content = c.content ?? "";
        let changed = false;
        for (const e of mine) {
            const text = e.field === "title" ? title : content;
            const n = count(text, e.find);
            if (!n) {
                result.failed.push({ chapter: index, field: e.field, find: e.find, reason: "the text changed since the proposal" });
                continue;
            }
            const next = text.split(e.find).join(e.replace);
            if (e.field === "title") title = next;
            else content = next;
            changed = true;
            result.applied.push({ chapter: index, field: e.field, find: e.find, occurrences: n });
        }
        if (!changed) continue;
        await keepVersion(db, c, "assistant");
        await db.update(chapter).set({ title, content }).where(eq(chapter.id, c.id));
    }
    return result;
}
