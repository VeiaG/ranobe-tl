import type { PendingGroup } from "./decisions";

export interface DecisionGroup {
    key: string;
    novelId: number;
    novelTitle: string;
    term: { id: number; source: string; target: string; type: string; note: string; locked: boolean; gender: string | null; firstChapter: number | null };
    /** "new": a new term to review (ask-new). */
    field: "target" | "gender" | "new";
    current: string;
    changes: { id: number; newValue: string; chapter: number | null; reason: string; evidence: string; createdAt: string }[];
}

export function serializeGroups(groups: PendingGroup[]): DecisionGroup[] {
    return groups.map((g) => ({
        key: `${g.term.id}:${g.field}`,
        novelId: g.novelId,
        novelTitle: g.novelTitle,
        term: {
            id: g.term.id,
            source: g.term.source,
            target: g.term.target,
            type: g.term.type,
            note: g.term.note,
            locked: g.term.locked,
            gender: g.gender,
            firstChapter: g.term.firstChapter,
        },
        field: g.field,
        current: g.field === "target" ? g.term.target : g.changes[0].oldValue,
        changes: g.changes.map((c) => ({ id: c.id, newValue: c.newValue, chapter: c.chapter, reason: c.reason, evidence: c.evidence, createdAt: c.createdAt.toISOString() })),
    }));
}
