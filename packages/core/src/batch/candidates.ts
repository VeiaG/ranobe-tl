import { z } from "zod";
import { TERM_TYPES, genderAt, type Gender, type GenderEntry, type Term, type TermType } from "../glossary/store";

/** One term as the extraction model reported it for one chapter. */
export interface ExtractedTerm {
    source: string;
    target: string;
    type: TermType;
    gender?: Gender;
    note?: string;
    evidence?: string;
}

const ExtractedSchema = z.object({
    source: z.string().trim().min(1),
    target: z.string().trim().default(""),
    type: z
        .string()
        .transform((t) => ((TERM_TYPES as readonly string[]).includes(t) ? t : "other") as TermType)
        .default("other"),
    gender: z.enum(["m", "f", "unknown"]).optional().catch(undefined),
    note: z.string().optional().catch(undefined),
    evidence: z.string().optional().catch(undefined),
});

/** The JSON array of an extraction reply; tolerates code fences, <think> blocks and text around the array. */
export function parseExtraction(raw: string): { terms: ExtractedTerm[]; problems: string[] } {
    const text = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/```[a-z]*\n?|```/g, "");
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end < start) return { terms: [], problems: ["no JSON array in the reply"] };
    let json: unknown;
    try {
        json = JSON.parse(text.slice(start, end + 1));
    } catch {
        return { terms: [], problems: ["the reply is not valid JSON"] };
    }
    const terms: ExtractedTerm[] = [];
    for (const item of Array.isArray(json) ? json : []) {
        const parsed = ExtractedSchema.safeParse(item);
        if (!parsed.success || !parsed.data.target) continue;
        const t = parsed.data;
        // only persons have a gender; a title follows its holder
        terms.push({ ...t, gender: t.type === "person" ? t.gender : undefined });
    }
    return { terms, problems: [] };
}

/** A stored extraction result of one chapter. */
export interface Candidate {
    chapter: number;
    source: string;
    target: string;
    type: TermType;
    gender: Gender | null;
    note: string;
    evidence: string;
}

export interface Variant {
    target: string;
    count: number;
    chapters: number[];
}

/** Translations proposed for a term, most frequent first; spelling variants that differ only in case are one. */
export function variantsOf(candidates: Candidate[]): Variant[] {
    const byKey = new Map<string, { spellings: Map<string, number>; chapters: Set<number>; count: number }>();
    for (const c of candidates) {
        const key = c.target.trim().toLowerCase();
        const v = byKey.get(key) ?? { spellings: new Map(), chapters: new Set(), count: 0 };
        v.spellings.set(c.target.trim(), (v.spellings.get(c.target.trim()) ?? 0) + 1);
        v.chapters.add(c.chapter);
        v.count++;
        byKey.set(key, v);
    }
    return [...byKey.values()]
        .map((v) => ({
            target: [...v.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0],
            count: v.count,
            chapters: [...v.chapters].sort((a, b) => a - b),
        }))
        .sort((a, b) => b.count - a.count || a.chapters[0] - b.chapters[0]);
}

/** The type most candidates gave; a tie goes to the earliest chapter. */
export function majorityType(candidates: Candidate[]): TermType {
    const counts = new Map<TermType, { n: number; first: number }>();
    for (const c of candidates) {
        const x = counts.get(c.type) ?? { n: 0, first: c.chapter };
        x.n++;
        x.first = Math.min(x.first, c.chapter);
        counts.set(c.type, x);
    }
    return [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)[0]?.[0] ?? "other";
}

/**
 * Known genders by chapter, merged where they repeat: [m@1] or [m@1, f@40].
 * Unknown ones are left out: they never contradict anything.
 */
export function genderTimeline(candidates: Candidate[]): GenderEntry[] {
    const known = candidates.filter((c) => c.gender === "m" || c.gender === "f").sort((a, b) => a.chapter - b.chapter);
    const out: GenderEntry[] = [];
    for (const c of known) {
        if (out[out.length - 1]?.gender !== c.gender) out.push({ fromChapter: c.chapter, gender: c.gender! });
    }
    return out;
}

export interface ProposedEntry {
    source: string;
    target: string;
    type: TermType;
    note: string;
    firstChapter: number;
    /** For persons: [] when the gender is unknown. */
    genders: GenderEntry[];
}

export type Resolution =
    /** A new term every candidate agrees on: add it. */
    | { kind: "add"; entry: ProposedEntry }
    /** The glossary already has it and the candidates agree; `gender` fills a gender the glossary does not know. */
    | { kind: "agrees"; gender?: Gender }
    /** Needs a human (or the model, on request). */
    | { kind: "conflict"; reasons: string[] };

/** What the merge would do with the candidates of one term, given the glossary entry if there is one. */
export function resolveCandidates(candidates: Candidate[], existing?: Term): Resolution {
    const variants = variantsOf(candidates);
    const type = existing?.type ?? majorityType(candidates);
    const timeline = type === "person" ? genderTimeline(candidates) : [];
    const reasons: string[] = [];

    if (existing) {
        const others = variants.filter((v) => v.target.toLowerCase() !== existing.target.toLowerCase());
        if (others.length) reasons.push(`other translations: ${others.map((v) => `${v.target} (${v.count})`).join(", ")}`);
        let fill: Gender | undefined;
        if (type === "person" && timeline.length) {
            const knows = existing.genders.some((g) => g.gender !== "unknown");
            if (!knows) {
                if (timeline.length === 1) fill = timeline[0].gender;
                else reasons.push(`gender changes: ${describeTimeline(timeline)}`);
            } else {
                const clash = candidates.find((c) => (c.gender === "m" || c.gender === "f") && genderAt(existing, c.chapter) !== c.gender);
                if (clash) reasons.push(`gender ${clash.gender} in chapter ${clash.chapter}, the glossary says ${genderAt(existing, clash.chapter)}`);
            }
        }
        return reasons.length ? { kind: "conflict", reasons } : { kind: "agrees", gender: fill };
    }

    if (variants.length > 1) reasons.push(`${variants.length} translations: ${variants.map((v) => `${v.target} (${v.count})`).join(", ")}`);
    if (timeline.length > 1) reasons.push(`gender changes: ${describeTimeline(timeline)}`);
    if (reasons.length) return { kind: "conflict", reasons };

    const first = [...candidates].sort((a, b) => a.chapter - b.chapter)[0];
    const firstChapter = first.chapter;
    return {
        kind: "add",
        entry: {
            source: first.source.trim(),
            target: variants[0].target,
            type,
            note: candidates.find((c) => c.note.trim())?.note.trim() ?? "",
            firstChapter,
            genders: type === "person" ? (timeline.length ? [{ fromChapter: firstChapter, gender: timeline[0].gender }] : [{ fromChapter: firstChapter, gender: "unknown" }]) : [],
        },
    };
}

export function describeTimeline(timeline: GenderEntry[]): string {
    return timeline.map((g) => `${g.gender}@${g.fromChapter}`).join(" → ");
}
