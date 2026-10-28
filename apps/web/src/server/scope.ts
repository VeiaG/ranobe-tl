import { and, between, inArray, type SQL } from "drizzle-orm";
import { chapter, type ChapterStatus } from "@/db/schema";

export type RunScope =
    | { kind: "untranslated" }
    | { kind: "failed" }
    | { kind: "range"; from: number; to: number; retranslate: boolean }
    | { kind: "chapters"; indexes: number[] };

/** Chapters a run with this scope would queue (within one novel). */
export function scopeWhere(scope: RunScope): SQL | undefined {
    if (scope.kind === "untranslated") return inArray(chapter.status, ["new"] satisfies ChapterStatus[]);
    if (scope.kind === "failed") return inArray(chapter.status, ["failed"] satisfies ChapterStatus[]);
    if (scope.kind === "range") {
        const statuses: ChapterStatus[] = scope.retranslate ? ["new", "failed", "skipped", "done"] : ["new", "failed"];
        return and(between(chapter.index, Math.min(scope.from, scope.to), Math.max(scope.from, scope.to)), inArray(chapter.status, statuses));
    }
    return and(inArray(chapter.index, scope.indexes.length ? scope.indexes : [-1]), inArray(chapter.status, ["new", "failed", "skipped", "done"] satisfies ChapterStatus[]));
}
