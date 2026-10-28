import type { DB } from "@/db";
import { event } from "@/db/schema";

export type Level = "info" | "success" | "warning" | "error";

export async function logEvent(db: DB, novelId: number, level: Level, message: string, chapter?: number | null): Promise<void> {
    await db.insert(event).values({ novelId, level, message, chapter: chapter ?? null });
}
