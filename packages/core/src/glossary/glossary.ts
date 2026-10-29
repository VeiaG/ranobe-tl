import { TermMatcher } from "./match";
import { levenshtein, looseKey, normalizeTerm } from "./normalize";
import { ChangeField, Gender, GlossaryStore, Term, TermType, genderAt } from "./store";

export interface ProposedTerm {
    source: string;
    target: string;
    type: TermType;
    gender?: Gender;
    note?: string;
    /** Exact quote from the source text that proves a gender change. */
    evidence?: string;
}

export type ProposalOutcome =
    | { kind: "added"; term: Term; lookalikes: Term[] }
    | { kind: "unchanged"; term: Term }
    | { kind: "gender-resolved"; term: Term; gender: Gender }
    | { kind: "gender-changed"; term: Term; from: Gender; to: Gender }
    | { kind: "pending"; term: Term; field: ChangeField; value: string; why: string }
    | { kind: "rejected"; term: Term; field: "target" | "gender"; value: string; why: string }
    | { kind: "similar"; proposed: ProposedTerm; similar: Term[] }
    /** The user said earlier that this is not a term. */
    | { kind: "ignored"; proposed: ProposedTerm };

export type PendingOutcome = Extract<ProposalOutcome, { kind: "pending" }>;

const NAME_TYPES = new Set<TermType>(["person", "place", "organization"]);

/**
 * Opt-in review of new terms: they are still added right away (so the next chunks use them),
 * but each one also waits for a decision. Limited to some types and/or early chapters if set.
 */
export interface AskNewPolicy {
    types?: TermType[];
    /** Only terms first seen up to this chapter are asked about. */
    untilChapter?: number;
}

export function asksAboutNew(policy: AskNewPolicy | undefined, type: TermType, chapter: number): boolean {
    if (!policy) return false;
    if (policy.types?.length && !policy.types.includes(type)) return false;
    if (policy.untilChapter && chapter > policy.untilChapter) return false;
    return true;
}

export interface GlossaryOptions {
    fixedTerms?: Record<string, string>;
    askNew?: AskNewPolicy;
}

/** Glossary with an in-memory matcher kept in sync with the store. */
export class Glossary {
    private terms = new Map<number, Term>();
    private matcher = new TermMatcher<number>();
    private fixed: Term[];

    private constructor(
        private store: GlossaryStore,
        terms: Term[],
        fixedTerms: Record<string, string>,
        private askNew?: AskNewPolicy
    ) {
        for (const t of terms) this.index(t);
        this.fixed = Object.entries(fixedTerms).map(([source, target], i) => ({
            id: -1 - i,
            source,
            target,
            type: "other" as const,
            note: "",
            locked: true,
            firstChapter: null,
            genders: [],
        }));
    }

    static async load(store: GlossaryStore, options: GlossaryOptions = {}): Promise<Glossary> {
        return new Glossary(store, await store.allTerms(), options.fixedTerms ?? {}, options.askNew);
    }

    get size(): number {
        return this.terms.size;
    }

    /** Terms occurring in the text plus all fixed terms. */
    relevant(text: string): Term[] {
        // a term deleted meanwhile (e.g. "not a term") stays in the matcher but not in the map
        const found = this.matcher.find(text).flatMap((id) => this.terms.get(id) ?? []);
        const fixedKeys = new Set(this.fixed.map((t) => normalizeTerm(t.source)));
        return [...this.fixed, ...found.filter((t) => !fixedKeys.has(normalizeTerm(t.source)))];
    }

    findSimilar(source: string): Term[] {
        const key = looseKey(source);
        const norm = normalizeTerm(source);
        const maxDist = norm.length >= 12 ? 2 : norm.length >= 6 ? 1 : 0;
        return [...this.terms.values()].filter((t) => {
            const other = normalizeTerm(t.source);
            if (other === norm) return false;
            if (looseKey(t.source) === key) return true;
            return maxDist > 0 && Math.abs(other.length - norm.length) <= maxDist && levenshtein(other, norm) <= maxDist;
        });
    }

    /**
     * Applies a term the model reported for a chapter:
     * - new term → added (unless it looks like a variant of an existing one → logged as "similar");
     *   with the ask-new policy it is also queued for review
     * - a term the user removed as "not a term" → ignored
     * - gender unknown → known: applied everywhere
     * - gender m ↔ f: applied from this chapter if the evidence quote is found in the source, else pending
     * - different translation: never applied automatically, goes to the pending queue (rejected if locked)
     * - a value rejected once is not queued again
     */
    async propose(p: ProposedTerm, chapter: number, sourceText: string): Promise<ProposalOutcome[]> {
        const existing = await this.store.findTerm(p.source);
        if (!existing) {
            if (await this.store.isIgnored(p.source)) return [{ kind: "ignored", proposed: p }];
            // Same term spelled differently (plural, hyphen, possessive) → don't add a duplicate.
            const variants = this.findSimilar(p.source).filter((t) => looseKey(t.source) === looseKey(p.source));
            if (variants.length) return [{ kind: "similar", proposed: p, similar: variants }];
            const lookalikes = this.findSimilar(p.source);
            const term = await this.store.insertTerm({
                source: p.source.trim(),
                target: p.target.trim(),
                type: p.type,
                note: p.note,
                firstChapter: chapter,
                gender: p.type === "person" ? (p.gender ?? "unknown") : undefined,
            });
            this.index(term);
            const added: ProposalOutcome = { kind: "added", term, lookalikes };
            if (!asksAboutNew(this.askNew, term.type, chapter)) return [added];
            await this.store.addChange({
                termId: term.id, field: "new", oldValue: "", newValue: term.target,
                chapter, evidence: p.evidence ?? "", reason: p.note ?? "", status: "pending",
            });
            return [added, { kind: "pending", term, field: "new", value: term.target, why: "new terms are reviewed" }];
        }

        const outcomes: ProposalOutcome[] = [];

        // A difference only in letter case is not a different translation.
        if (p.target.trim() && p.target.trim().toLowerCase() !== existing.target.toLowerCase()) {
            outcomes.push(await this.proposeTarget(existing, p, chapter));
        }
        if (existing.type === "person" && p.gender && p.gender !== "unknown") {
            const outcome = await this.proposeGender(existing, p, chapter, sourceText);
            if (outcome) outcomes.push(outcome);
        }

        const term = await this.reload(existing.id);
        return outcomes.length ? outcomes : [{ kind: "unchanged", term }];
    }

    private async proposeTarget(term: Term, p: ProposedTerm, chapter: number): Promise<ProposalOutcome> {
        const value = p.target.trim();
        const why = p.note ?? "";
        if (term.locked) {
            await this.store.addChange({
                termId: term.id, field: "target", oldValue: term.target, newValue: value,
                chapter, evidence: p.evidence ?? "", reason: why, status: "rejected",
            });
            return { kind: "rejected", term, field: "target", value, why: "term is locked" };
        }
        if (await this.store.hasChange(term.id, "target", value, "rejected")) {
            return { kind: "rejected", term, field: "target", value, why: "rejected before" };
        }
        if (!(await this.store.hasChange(term.id, "target", value, "pending"))) {
            await this.store.addChange({
                termId: term.id, field: "target", oldValue: term.target, newValue: value,
                chapter, evidence: p.evidence ?? "", reason: why, status: "pending",
            });
        }
        return { kind: "pending", term, field: "target", value, why: "translation changes need review" };
    }

    private async proposeGender(term: Term, p: ProposedTerm, chapter: number, sourceText: string): Promise<ProposalOutcome | undefined> {
        const to = p.gender!;
        const current = genderAt(term, chapter);
        if (current === to) return undefined;

        const change = { termId: term.id, field: "gender" as const, oldValue: current ?? "unknown", newValue: to, chapter, evidence: p.evidence ?? "", reason: p.note ?? "" };

        if (!current || current === "unknown") {
            if (term.genders.length) await this.store.resolveUnknownGender(term.id, to);
            else await this.store.setGender(term.id, term.firstChapter ?? chapter, to);
            await this.store.addChange({ ...change, status: "applied" });
            return { kind: "gender-resolved", term: await this.reload(term.id), gender: to };
        }

        if (term.locked) {
            await this.store.addChange({ ...change, status: "rejected" });
            return { kind: "rejected", term, field: "gender", value: to, why: "term is locked" };
        }

        if (evidenceFound(p.evidence, sourceText)) {
            await this.store.setGender(term.id, chapter, to);
            await this.store.addChange({ ...change, status: "applied" });
            return { kind: "gender-changed", term: await this.reload(term.id), from: current, to };
        }

        if (await this.store.hasChange(term.id, "gender", to, "rejected")) {
            return { kind: "rejected", term, field: "gender", value: to, why: "rejected before" };
        }
        if (!(await this.store.hasChange(term.id, "gender", to, "pending"))) {
            await this.store.addChange({ ...change, status: "pending" });
        }
        return { kind: "pending", term, field: "gender", value: to, why: p.evidence ? "evidence quote not found in source" : "no evidence quote" };
    }

    /** Re-reads a term changed in the store from outside (review, prompts). */
    async reload(id: number): Promise<Term> {
        const term = await this.store.getTerm(id);
        if (!term) {
            this.terms.delete(id);
            throw new Error(`term ${id} was deleted`);
        }
        this.terms.set(id, term);
        return term;
    }

    private index(term: Term): void {
        this.terms.set(term.id, term);
        this.matcher.add(term.source, term.id, NAME_TYPES.has(term.type));
    }
}

function squash(s: string): string {
    return s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").toLowerCase().trim();
}

export function evidenceFound(evidence: string | undefined, sourceText: string): boolean {
    if (!evidence || evidence.trim().length < 8) return false;
    return squash(sourceText).includes(squash(evidence));
}
