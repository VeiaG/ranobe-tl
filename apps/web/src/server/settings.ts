import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { instanceSetting } from "@/db/schema";

/** Typed access to one instance-wide setting; `fallback` fills what was never saved. */
export async function getSetting<T>(db: DB, key: string, fallback: T): Promise<T> {
    const [row] = await db.select().from(instanceSetting).where(eq(instanceSetting.key, key));
    return row ? { ...fallback, ...(row.value as object) } : fallback;
}

export async function setSetting<T>(db: DB, key: string, value: T): Promise<void> {
    await db
        .insert(instanceSetting)
        .values({ key, value })
        .onConflictDoUpdate({ target: instanceSetting.key, set: { value, updatedAt: new Date() } });
}
