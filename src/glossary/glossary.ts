import { TermMatcher } from "./match.js";
import { levenshtein, looseKey, normalizeTerm } from "./normalize.js";
import { Gender, GlossaryStore, Term, TermType, genderAt } from "./store.js";

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
    | { kind: "pending"; term: Term; field: "target" | "gender"; value: string; why: string }
    | { kind: "rejected"; term: Term; field: "target" | "gender"; value: string; why: string }
    | { kind: "similar"; proposed: ProposedTerm; similar: Term[] };

/** Glossary with an in-memory matcher kept in sync with the store. */
export class Glossary {
    private terms = new Map<number, Term>();
    private matcher = new TermMatcher<number>();
    private fixed: Term[];

    constructor(private store: GlossaryStore, fixedTerms: Record<string, string> = {}) {
        for (const t of store.allTerms()) this.index(t);
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

    get size(): number {
        return this.terms.size;
    }

    /** Terms occurring in the text plus all fixed terms. */
    relevant(text: string): Term[] {
        const found = this.matcher.find(text).map((id) => this.terms.get(id)!);
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
     * - new term → added (unless it looks like a variant of an existing one → logged as "similar")
     * - gender unknown → known: applied everywhere
     * - gender m ↔ f: applied from this chapter if the evidence quote is found in the source, else pending
     * - different translation: never applied automatically, goes to the pending queue (rejected if locked)
     */
    propose(p: ProposedTerm, chapter: number, sourceText: string): ProposalOutcome[] {
        const existing = this.store.findTerm(p.source);
        if (!existing) {
            // Same term spelled differently (plural, hyphen, possessive) → don't add a duplicate.
            const variants = this.findSimilar(p.source).filter((t) => looseKey(t.source) === looseKey(p.source));
            if (variants.length) return [{ kind: "similar", proposed: p, similar: variants }];
            const lookalikes = this.findSimilar(p.source);
            const term = this.store.insertTerm({
                source: p.source.trim(),
                target: p.target.trim(),
                type: p.type,
                note: p.note,
                firstChapter: chapter,
                gender: p.type === "person" ? (p.gender ?? "unknown") : undefined,
            });
            this.index(term);
            return [{ kind: "added", term, lookalikes }];
        }

        const outcomes: ProposalOutcome[] = [];

        if (p.target.trim() && p.target.trim() !== existing.target) {
            outcomes.push(this.proposeTarget(existing, p, chapter));
        }
        if (existing.type === "person" && p.gender && p.gender !== "unknown") {
            const outcome = this.proposeGender(existing, p, chapter, sourceText);
            if (outcome) outcomes.push(outcome);
        }

        const term = this.reload(existing.id);
        return outcomes.length ? outcomes : [{ kind: "unchanged", term }];
    }

    private proposeTarget(term: Term, p: ProposedTerm, chapter: number): ProposalOutcome {
        const value = p.target.trim();
        const why = p.note ?? "";
        if (term.locked) {
            this.store.addChange({
                termId: term.id, field: "target", oldValue: term.target, newValue: value,
                chapter, evidence: p.evidence ?? "", reason: why, status: "rejected",
            });
            return { kind: "rejected", term, field: "target", value, why: "term is locked" };
        }
        if (!this.store.hasPendingChange(term.id, "target", value)) {
            this.store.addChange({
                termId: term.id, field: "target", oldValue: term.target, newValue: value,
                chapter, evidence: p.evidence ?? "", reason: why, status: "pending",
            });
        }
        return { kind: "pending", term, field: "target", value, why: "translation changes need review" };
    }

    private proposeGender(term: Term, p: ProposedTerm, chapter: number, sourceText: string): ProposalOutcome | undefined {
        const to = p.gender!;
        const current = genderAt(term, chapter);
        if (current === to) return undefined;

        const change = { termId: term.id, field: "gender" as const, oldValue: current ?? "unknown", newValue: to, chapter, evidence: p.evidence ?? "", reason: p.note ?? "" };

        if (!current || current === "unknown") {
            if (term.genders.length) this.store.resolveUnknownGender(term.id, to);
            else this.store.setGender(term.id, term.firstChapter ?? chapter, to);
            this.store.addChange({ ...change, status: "applied" });
            return { kind: "gender-resolved", term: this.reload(term.id), gender: to };
        }

        if (term.locked) {
            this.store.addChange({ ...change, status: "rejected" });
            return { kind: "rejected", term, field: "gender", value: to, why: "term is locked" };
        }

        if (evidenceFound(p.evidence, sourceText)) {
            this.store.setGender(term.id, chapter, to);
            this.store.addChange({ ...change, status: "applied" });
            return { kind: "gender-changed", term: this.reload(term.id), from: current, to };
        }

        if (!this.store.hasPendingChange(term.id, "gender", to)) {
            this.store.addChange({ ...change, status: "pending" });
        }
        return { kind: "pending", term, field: "gender", value: to, why: p.evidence ? "evidence quote not found in source" : "no evidence quote" };
    }

    private reload(id: number): Term {
        const term = this.store.getTerm(id)!;
        this.terms.set(id, term);
        return term;
    }

    private index(term: Term): void {
        this.terms.set(term.id, term);
        this.matcher.add(term.source, term.id);
    }
}

function squash(s: string): string {
    return s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").toLowerCase().trim();
}

export function evidenceFound(evidence: string | undefined, sourceText: string): boolean {
    if (!evidence || evidence.trim().length < 8) return false;
    return squash(sourceText).includes(squash(evidence));
}
