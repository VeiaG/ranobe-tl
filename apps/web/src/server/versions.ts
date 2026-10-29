import { and, desc, eq, notInArray } from "drizzle-orm";
import type { DB } from "@/db";
import { chapterVersion } from "@/db/schema";

/** Earlier translations kept per chapter. */
export const KEEP_VERSIONS = 10;

export type ReplacedBy = "translation" | "edit" | "reset" | "restore" | "replace";

/** Saves the chapter's current text as a version before it is replaced; a chapter without text has nothing to keep. */
export async function keepVersion(
    db: DB,
    c: { id: number; title: string | null; content: string | null; model: string; translatedAt: Date | null },
    replacedBy: ReplacedBy
): Promise<void> {
    if (!c.content) return;
    await db.insert(chapterVersion).values({ chapterId: c.id, title: c.title, content: c.content, model: c.model, translatedAt: c.translatedAt, replacedBy });
    const keep = await db
        .select({ id: chapterVersion.id })
        .from(chapterVersion)
        .where(eq(chapterVersion.chapterId, c.id))
        .orderBy(desc(chapterVersion.id))
        .limit(KEEP_VERSIONS);
    await db.delete(chapterVersion).where(and(eq(chapterVersion.chapterId, c.id), notInArray(chapterVersion.id, keep.map((k) => k.id))));
}
