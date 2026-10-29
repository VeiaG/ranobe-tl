"use server";

import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { chapter, novel } from "@/db/schema";
import { askServiceModel } from "@/server/service-model";
import { requireUser } from "@/server/session";
import { action } from "./util";

export interface PatternCheck {
    pattern: string;
    /** Set when the pattern does not compile. */
    error: string | null;
    chapters: number;
    matches: number;
    /** A few distinct matched texts. */
    samples: string[];
}

const Suggestion = z.object({
    patterns: z.array(z.string()).describe("JavaScript regular expressions, applied with the flags gim to the whole chapter text"),
    explanation: z.string().describe("One or two sentences for the user: what the patterns remove"),
});

const SYSTEM = `You write regular expressions that remove junk from the source text of web novel chapters before translation: translator credits, ads, links, scraper leftovers, Patreon notes and the like.
The patterns are JavaScript regexes applied with the flags "gim" (global, case-insensitive, ^ and $ match at line starts and ends) and every match is replaced with nothing.
- Remove whole lines: anchor with ^ and $ and use .* inside the line, never [\\s\\S] or flags that span lines unless the user asks for a block.
- Be specific enough not to touch the story: a pattern that could match normal prose is worse than missing a rare variant.
- Prefer one pattern per kind of junk; use alternation for spelling variants.
- Answer with patterns only for what the user asked; an empty list if the samples show nothing like it.`;

const MAX_LINE = 300;

/** What the model sees: lines repeated across many chapters (junk usually is) and the edges of a few chapters. */
function samples(sources: { index: number; source: string }[]) {
    const seen = new Map<string, { line: string; chapters: number }>();
    for (const { source } of sources) {
        const lines = new Set(
            source
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length >= 3 && l.length <= MAX_LINE)
        );
        for (const line of lines) {
            const key = line.toLowerCase();
            const entry = seen.get(key);
            if (entry) entry.chapters++;
            else seen.set(key, { line, chapters: 1 });
        }
    }
    const min = Math.max(3, Math.ceil(sources.length * 0.02));
    const repeated = [...seen.values()]
        .filter((e) => e.chapters >= min)
        .sort((a, b) => b.chapters - a.chapters)
        .slice(0, 60);

    const picks = sources.length <= 6 ? sources : Array.from({ length: 6 }, (_, i) => sources[Math.round((i * (sources.length - 1)) / 5)]);
    const edges = picks.map(({ index, source }) => {
        const lines = source.split("\n").filter((l) => l.trim()).map((l) => l.slice(0, MAX_LINE));
        const body = lines.length <= 24 ? lines : [...lines.slice(0, 12), "[…]", ...lines.slice(-12)];
        return `--- chapter ${index} (start and end) ---\n${body.join("\n")}`;
    });
    return [
        `Lines repeated in many of the ${sources.length} chapters (number of chapters, line):`,
        repeated.length ? repeated.map((e) => `${e.chapters}\t${e.line}`).join("\n") : "(none)",
        "",
        ...edges,
    ].join("\n");
}

/** Runs patterns over all sources of the novel the way the translator does (flags gim). */
function check(patterns: string[], sources: { source: string }[]): PatternCheck[] {
    return patterns.map((pattern) => {
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, "gim");
        } catch (error) {
            return { pattern, error: error instanceof Error ? error.message : String(error), chapters: 0, matches: 0, samples: [] };
        }
        let chapters = 0;
        let matches = 0;
        const found = new Set<string>();
        for (const { source } of sources) {
            const all = [...source.replace(/\r\n|\r/g, "\n").matchAll(regex)].filter((m) => m[0]);
            if (!all.length) continue;
            chapters++;
            matches += all.length;
            for (const m of all) if (found.size < 8) found.add(m[0].trim().slice(0, 200));
        }
        return { pattern, error: null, chapters, matches, samples: [...found] };
    });
}

/** Asks the service model for patterns that remove what the user described, and checks them on the novel's sources. */
export async function suggestPatterns(novelId: number, request: string) {
    return action(async () => {
        await requireUser();
        const what = request.trim();
        if (!what) throw new Error("Describe what to remove");
        const [n] = await db.select({ id: novel.id, title: novel.title }).from(novel).where(eq(novel.id, novelId));
        if (!n) throw new Error("Novel not found");
        const sources = await db.select({ index: chapter.index, source: chapter.source }).from(chapter).where(eq(chapter.novelId, novelId)).orderBy(asc(chapter.index));
        if (!sources.length) throw new Error("Upload some chapters first: the patterns are made from their sources");

        let prompt = `What to remove: ${what}\n\n${samples(sources)}`;
        // one more try when a pattern does not compile, with the error
        for (let attempt = 1; ; attempt++) {
            const answer = await askServiceModel(db, { system: SYSTEM, prompt, schema: Suggestion, novel: n });
            const checks = check(answer.patterns.map((p) => p.trim()).filter(Boolean), sources);
            const broken = checks.filter((c) => c.error);
            if (!broken.length || attempt === 2) return { explanation: answer.explanation, checks, chapters: sources.length };
            prompt += `\n\nYour previous answer had invalid patterns:\n${broken.map((c) => `${c.pattern}: ${c.error}`).join("\n")}\nAnswer again with valid ones.`;
        }
    });
}
