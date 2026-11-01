import "server-only";
import { z } from "zod";
import { escapeRegExp, makeSnippet } from "@/lib/text-replace";
import type { DraftRow } from "./assistant-draft";

// The chat assistant of the Replace tab: searches and reads the chapters of its draft (see assistant-draft),
// so it sees its own changes; nothing reaches the real chapters until the user applies the draft.

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

/** Searches the translated chapters (titles and text) or the sources of the draft. */
export function search(all: DraftRow[], where: "translation" | "source", input: z.infer<typeof SearchInput>) {
    const regex = buildSearch(input);
    const rows = where === "translation" ? all.filter((r) => r.status === "done") : all;

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

export function readChapter(r: DraftRow | undefined, input: z.infer<typeof ReadInput>) {
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
