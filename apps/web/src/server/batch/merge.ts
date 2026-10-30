import { and, asc, eq, inArray } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import {
    TERM_TYPES,
    createModel,
    describeTimeline,
    genderTimeline,
    looseKey,
    majorityType,
    resolveCandidates,
    variantsOf,
    wellFormed,
    type Candidate,
    type Gender,
    type Term,
    type TermType,
} from "@ranobe-tl/core";
import type { DB } from "@/db";
import { chapter, ignoredTerm, novel, termAdvice, termCandidate, termGender, usageRecord, type TermAdvice } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { PgGlossaryStore } from "@/server/glossary-store";
import { batchSetup } from "./submit";

type CandidateRow = typeof termCandidate.$inferSelect;

function toCandidate(r: CandidateRow): Candidate {
    return { chapter: r.chapter, source: r.source, target: r.target, type: r.type as TermType, gender: (r.gender as Gender | null) ?? null, note: r.note, evidence: r.evidence };
}

function groupBy(rows: CandidateRow[]): Map<string, CandidateRow[]> {
    const groups = new Map<string, CandidateRow[]>();
    for (const r of rows) groups.set(r.groupKey, [...(groups.get(r.groupKey) ?? []), r]);
    return groups;
}

/** Glossary terms by looseKey: a candidate "Sky Towers" belongs to the term "Sky Tower". */
async function termsByKey(store: PgGlossaryStore): Promise<Map<string, Term>> {
    const map = new Map<string, Term>();
    for (const t of await store.allTerms()) if (!map.has(looseKey(t.source))) map.set(looseKey(t.source), t);
    return map;
}

async function ignoredKeys(db: DB, novelId: number): Promise<Set<string>> {
    const rows = await db.select({ source: ignoredTerm.source }).from(ignoredTerm).where(eq(ignoredTerm.novelId, novelId));
    return new Set(rows.map((r) => looseKey(r.source)));
}

async function setStatus(db: DB, ids: number[], status: CandidateRow["status"]) {
    if (ids.length) await db.update(termCandidate).set({ status }).where(inArray(termCandidate.id, ids));
}

/** The source spelled the way most candidates spell it, earliest first on a tie. */
function commonSource(rows: CandidateRow[]): string {
    const counts = new Map<string, number>();
    for (const r of [...rows].sort((a, b) => a.chapter - b.chapter)) counts.set(r.source.trim(), (counts.get(r.source.trim()) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Merges what needs no decision: new terms every chapter agrees on are added, candidates that match the
 * glossary are closed, sources marked "not a term" are dropped. Conflicts stay pending for the Candidates page.
 */
export async function autoResolve(db: DB, novelId: number): Promise<{ added: number; matched: number; conflicts: number; dropped: number }> {
    const rows = await db.select().from(termCandidate).where(and(eq(termCandidate.novelId, novelId), eq(termCandidate.status, "pending")));
    const store = new PgGlossaryStore(db, novelId);
    const terms = await termsByKey(store);
    const ignored = await ignoredKeys(db, novelId);
    const accepted: number[] = [];
    const dismissed: number[] = [];
    const out = { added: 0, matched: 0, conflicts: 0, dropped: 0 };

    for (const [key, group] of groupBy(rows)) {
        const ids = group.map((r) => r.id);
        if (ignored.has(key)) {
            dismissed.push(...ids);
            out.dropped++;
            continue;
        }
        const existing = terms.get(key);
        const res = resolveCandidates(group.map(toCandidate), existing);
        if (res.kind === "conflict") {
            out.conflicts++;
            continue;
        }
        if (res.kind === "add") {
            const term = await store.insertTerm({ ...res.entry, source: commonSource(group), gender: res.entry.genders[0]?.gender });
            terms.set(key, term);
            out.added++;
        } else {
            if (existing && res.gender) {
                if (existing.genders.length) await store.resolveUnknownGender(existing.id, res.gender);
                else await store.setGender(existing.id, existing.firstChapter ?? 1, res.gender);
            }
            out.matched++;
        }
        accepted.push(...ids);
    }
    await setStatus(db, accepted, "accepted");
    await setStatus(db, dismissed, "dismissed");
    return out;
}

export interface CandidateGroup {
    key: string;
    source: string;
    variants: { target: string; count: number; chapters: number[] }[];
    type: TermType;
    types: Record<string, number>;
    timeline: string;
    genders: { fromChapter: number; gender: Gender }[];
    chapters: number;
    firstChapter: number;
    notes: string[];
    reasons: string[];
    existing: { id: number; target: string; type: TermType; gender: string; locked: boolean } | null;
    advice: TermAdvice | null;
}

/** Pending candidates by term, the most frequent first: the main cast comes before one-off names. */
export async function candidateGroups(db: DB, novelId: number): Promise<CandidateGroup[]> {
    const rows = await db
        .select()
        .from(termCandidate)
        .where(and(eq(termCandidate.novelId, novelId), eq(termCandidate.status, "pending")))
        .orderBy(asc(termCandidate.chapter));
    if (!rows.length) return [];
    const terms = await termsByKey(new PgGlossaryStore(db, novelId));
    const advice = new Map((await db.select().from(termAdvice).where(eq(termAdvice.novelId, novelId))).map((a) => [a.groupKey, a.advice]));

    const groups: CandidateGroup[] = [];
    for (const [key, group] of groupBy(rows)) {
        const cands = group.map(toCandidate);
        const existing = terms.get(key);
        const res = resolveCandidates(cands, existing);
        const timeline = genderTimeline(cands);
        const types: Record<string, number> = {};
        for (const c of cands) types[c.type] = (types[c.type] ?? 0) + 1;
        const chapters = new Set(cands.map((c) => c.chapter));
        groups.push({
            key,
            source: existing?.source ?? commonSource(group),
            variants: variantsOf(cands),
            type: existing?.type ?? majorityType(cands),
            types,
            timeline: describeTimeline(timeline),
            genders: timeline,
            chapters: chapters.size,
            firstChapter: Math.min(...chapters),
            notes: [...new Set(cands.map((c) => c.note.trim()).filter(Boolean))].slice(0, 5),
            reasons: res.kind === "conflict" ? res.reasons : [],
            existing: existing
                ? { id: existing.id, target: existing.target, type: existing.type, gender: describeTimeline(existing.genders.filter((g) => g.gender !== "unknown")), locked: existing.locked }
                : null,
            advice: advice.get(key) ?? null,
        });
    }
    return groups.sort((a, b) => b.chapters - a.chapters || a.firstChapter - b.firstChapter);
}

export interface MergeChoice {
    target: string;
    type: TermType;
    note: string;
    /** "timeline": the genders as the chapters show them (m@1 → f@40). */
    gender: Gender | "timeline";
}

/** Writes the chosen entry to the glossary (new term or a change of the existing one) and closes the candidates. */
export async function acceptGroup(db: DB, novelId: number, key: string, choice: MergeChoice): Promise<{ termId: number; changed: boolean }> {
    const group = await db
        .select()
        .from(termCandidate)
        .where(and(eq(termCandidate.novelId, novelId), eq(termCandidate.groupKey, key), eq(termCandidate.status, "pending")));
    if (!group.length) throw new Error("Nothing left to merge for this term");
    const target = choice.target.trim();
    if (!target) throw new Error("Give the translation");
    const store = new PgGlossaryStore(db, novelId);
    const existing = (await termsByKey(store)).get(key);
    const firstChapter = Math.min(...group.map((r) => r.chapter), existing?.firstChapter ?? Infinity);
    const timeline = choice.gender === "timeline" ? genderTimeline(group.map(toCandidate)) : [];

    let termId: number;
    let changed = false;
    if (existing) {
        if (existing.locked && existing.target !== target) throw new Error("The term is locked in the glossary; unlock it first");
        changed = existing.target !== target;
        await store.updateTerm(existing.id, { target, type: choice.type, note: choice.note.trim() });
        termId = existing.id;
    } else {
        const term = await store.insertTerm({ source: commonSource(group), target, type: choice.type, note: choice.note.trim(), firstChapter });
        termId = term.id;
    }
    // the gender is set as a whole: a single one from the first chapter, or the timeline
    await db.delete(termGender).where(eq(termGender.termId, termId));
    if (choice.type === "person") {
        const entries = choice.gender === "timeline" ? timeline : [{ fromChapter: firstChapter, gender: choice.gender }];
        const genders = entries.length ? entries : [{ fromChapter: firstChapter, gender: "unknown" as Gender }];
        genders[0] = { ...genders[0], fromChapter: Math.min(genders[0].fromChapter, firstChapter) };
        for (const g of genders) await store.setGender(termId, g.fromChapter, g.gender);
    }
    await setStatus(db, group.map((r) => r.id), "accepted");
    await db.delete(termAdvice).where(and(eq(termAdvice.novelId, novelId), eq(termAdvice.groupKey, key)));
    return { termId, changed };
}

/** Closes the candidates without touching the glossary; `notATerm` also drops the source from future extractions. */
export async function dismissGroup(db: DB, novelId: number, key: string, notATerm: boolean): Promise<void> {
    const group = await db
        .select()
        .from(termCandidate)
        .where(and(eq(termCandidate.novelId, novelId), eq(termCandidate.groupKey, key), eq(termCandidate.status, "pending")));
    if (!group.length) return;
    if (notATerm) await new PgGlossaryStore(db, novelId).ignore(commonSource(group));
    await setStatus(db, group.map((r) => r.id), "dismissed");
    await db.delete(termAdvice).where(and(eq(termAdvice.novelId, novelId), eq(termAdvice.groupKey, key)));
}

export interface Snippet {
    chapter: number;
    before: string;
    match: string;
    after: string;
    /** The translation the extraction proposed in that chapter. */
    target: string;
}

const SNIPPET_CHARS = 220;
const MAX_SNIPPETS = 8;

/** Up to a few chapters spread over the whole range: the first, the last and some between. */
function spread<T>(items: T[], n: number): T[] {
    if (items.length <= n) return items;
    return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);
}

/** Where the term occurs, from the sources of the chapters it was found in. */
export async function groupSnippets(db: DB, novelId: number, key: string): Promise<Snippet[]> {
    const rows = await db
        .select()
        .from(termCandidate)
        .where(and(eq(termCandidate.novelId, novelId), eq(termCandidate.groupKey, key)))
        .orderBy(asc(termCandidate.chapter));
    const byChapter = new Map(rows.map((r) => [r.chapter, r]));
    const picked = spread([...byChapter.keys()], MAX_SNIPPETS);
    if (!picked.length) return [];
    const sources = await db
        .select({ index: chapter.index, source: chapter.source })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), inArray(chapter.index, picked)));
    const spellings = [...new Set(rows.map((r) => r.source.trim()))].sort((a, b) => b.length - a.length);
    const out: Snippet[] = [];
    for (const s of sources.sort((a, b) => a.index - b.index)) {
        const lower = s.source.toLowerCase();
        let at = -1;
        let word = "";
        for (const sp of spellings) {
            at = lower.indexOf(sp.toLowerCase());
            if (at !== -1) {
                word = s.source.slice(at, at + sp.length);
                break;
            }
        }
        const cand = byChapter.get(s.index)!;
        if (at === -1) {
            if (cand.evidence) out.push({ chapter: s.index, before: "", match: "", after: cand.evidence, target: cand.target });
            continue;
        }
        const start = Math.max(0, at - SNIPPET_CHARS);
        const end = Math.min(s.source.length, at + word.length + SNIPPET_CHARS);
        out.push({
            chapter: s.index,
            // a cut can split an emoji: the half left over would make the "Ask the model" request invalid JSON
            before: wellFormed((start > 0 ? "…" : "") + s.source.slice(start, at).replace(/\s+/g, " ")),
            match: word,
            after: wellFormed(s.source.slice(at + word.length, end).replace(/\s+/g, " ") + (end < s.source.length ? "…" : "")),
            target: cand.target,
        });
    }
    return out;
}

const AdviceSchema = z.object({
    target: z.string().describe("the translation to use everywhere, nominative case"),
    type: z.enum(TERM_TYPES),
    gender: z.enum(["m", "f", "unknown"]).describe('for type "person" only; "unknown" otherwise'),
    note: z.string().describe("a few words: who or what it is"),
    reason: z.string().describe("one or two sentences: why this choice"),
});

/** Asks the novel's model which entry to keep for a conflicting term; the answer is kept until the term is merged. */
export async function adviseGroup(db: DB, novelId: number, key: string): Promise<TermAdvice> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n) throw new Error("Novel not found");
    const group = (await candidateGroups(db, novelId)).find((g) => g.key === key);
    if (!group) throw new Error("Nothing left to merge for this term");
    const { key: apiKey, config, model } = await batchSetup(db, n);
    const setup = createModel(config, decrypt(apiKey.encryptedKey));
    const snippets = await groupSnippets(db, novelId, key);

    const system = `You keep the glossary of a ${config.sourceLanguage} → ${config.targetLanguage} translation of a web novel consistent.
${config.novel.title ? `Novel: ${config.novel.title}\n` : ""}${config.novel.synopsis ? `Synopsis: ${config.novel.synopsis}\n` : ""}
Several chapters proposed different entries for one term. Choose the one entry the whole translation will use.
- Prefer the translation that is correct for the term's meaning across all the excerpts, then the most consistent and natural one in ${config.targetLanguage}; frequency is a hint, not a rule.
- Titles and ranks are type "rank" and have no gender: give the base (masculine or neutral) form; the translator puts it in the holder's gender. A title held by a woman is not a reason for a feminine entry.
- For a person, a gender that changes between chapters is usually a mistake of one chapter; choose the gender the excerpts support.${config.instructions ? `\n\nNotes from the user about this novel:\n${config.instructions}` : ""}`;

    const lines = [
        `Term: ${group.source}`,
        group.existing ? `In the glossary now: ${group.existing.target} [${group.existing.type}${group.existing.gender ? `, ${group.existing.gender}` : ""}]` : "Not in the glossary yet.",
        `Proposed translations: ${group.variants.map((v) => `${v.target} (${v.count}× in chapters ${v.chapters.slice(0, 8).join(", ")}${v.chapters.length > 8 ? ", …" : ""})`).join("; ")}`,
        `Proposed types: ${Object.entries(group.types).map(([t, c]) => `${t} ${c}×`).join(", ")}`,
        group.timeline ? `Genders by chapter: ${group.timeline}` : "",
        group.notes.length ? `Notes: ${group.notes.join(" | ")}` : "",
        "",
        "Excerpts from the source:",
        ...snippets.map((s) => `[chapter ${s.chapter}, proposed "${s.target}"] ${s.before}${s.match}${s.after}`),
    ]
        .filter((l) => l !== "")
        .join("\n");
    const prompt = wellFormed(lines);

    const record = (usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined, ok: boolean) =>
        db.insert(usageRecord).values({
            novelId,
            novelTitle: n.title,
            keyId: apiKey.id,
            provider: apiKey.provider,
            model,
            inputTokens: usage?.inputTokens ?? 0,
            cachedTokens: usage?.cachedInputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            ok,
        });
    let advice: TermAdvice;
    try {
        const res = await generateText({ model: setup.model, system: wellFormed(system), prompt, providerOptions: setup.providerOptions, output: Output.object({ schema: AdviceSchema }) });
        await record(res.usage, true);
        advice = { ...res.output, gender: res.output.type === "person" ? res.output.gender : "unknown" };
    } catch (error) {
        const usage = (error as { usage?: Parameters<typeof record>[0] }).usage;
        if (usage) await record(usage, false);
        throw error;
    }
    await db
        .insert(termAdvice)
        .values({ novelId, groupKey: key, advice })
        .onConflictDoUpdate({ target: [termAdvice.novelId, termAdvice.groupKey], set: { advice, createdAt: new Date() } });
    return advice;
}
