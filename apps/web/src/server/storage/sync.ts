import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import type { DB } from "@/db";
import { chapter, novel } from "@/db/schema";
import { getSetting, setSetting } from "../settings";
import { Bucket, STORAGE_STATUS_DEFAULTS, STORAGE_STATUS_KEY, openBucket, storageConfig, type StorageStatus } from "./client";
import { chapterFileName, glossaryJson, novelJson, sha1, slugify, translationFile } from "./folder";

/** Uploads at the same time; enough to hide latency without hammering a small bucket. */
const PARALLEL = 4;

async function inParallel<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
            while (i < items.length) await fn(items[i++]);
        })
    );
}

/** The novel's folder: its title as a slug, fixed at the first sync, made unique if needed. */
async function folderOf(db: DB, n: typeof novel.$inferSelect): Promise<string> {
    if (n.storageFolder) return n.storageFolder;
    const taken = new Set(
        (await db.select({ f: novel.storageFolder }).from(novel).where(and(isNotNull(novel.storageFolder), ne(novel.id, n.id)))).map((r) => r.f)
    );
    let folder = slugify(n.title);
    if (taken.has(folder)) folder = `${folder}-${n.id}`;
    await db.update(novel).set({ storageFolder: folder }).where(eq(novel.id, n.id));
    return folder;
}

/**
 * Brings the novel's folder in the bucket up to date. Only files whose content changed since the
 * last upload are sent; nothing is ever deleted there (it is a backup, not a mirror).
 */
export async function syncNovel(db: DB, bucket: Bucket, novelId: number, includeSources: boolean): Promise<number> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n) return 0;
    const folder = await folderOf(db, n);
    let uploaded = 0;

    const [config, glossary] = await Promise.all([novelJson(db, n), glossaryJson(db, novelId)]);
    const metaHash = sha1(config + glossary);
    if (metaHash !== n.storageMetaHash) {
        await bucket.put(`${folder}/novel.json`, config, "application/json; charset=utf-8");
        await bucket.put(`${folder}/glossary.json`, glossary, "application/json; charset=utf-8");
        await db.update(novel).set({ storageMetaHash: metaHash }).where(eq(novel.id, novelId));
        uploaded += 2;
    }

    const rows = await db
        .select({
            id: chapter.id,
            index: chapter.index,
            status: chapter.status,
            title: chapter.title,
            content: chapter.content,
            source: chapter.source,
            storageHash: chapter.storageHash,
            storageSourceHash: chapter.storageSourceHash,
        })
        .from(chapter)
        .where(eq(chapter.novelId, novelId))
        .orderBy(asc(chapter.index));
    const max = rows.at(-1)?.index ?? 1;

    await inParallel(rows, async (r) => {
        const name = chapterFileName(r.index, max);
        const set: Partial<typeof chapter.$inferInsert> = {};
        if (r.status === "done" && r.content) {
            const body = translationFile(r);
            const hash = sha1(body);
            if (hash !== r.storageHash) {
                await bucket.put(`${folder}/translation/${name}.json`, body, "application/json; charset=utf-8");
                set.storageHash = hash;
                uploaded++;
            }
        }
        if (includeSources && r.source) {
            const hash = sha1(r.source);
            if (hash !== r.storageSourceHash) {
                await bucket.put(`${folder}/chapters/${name}.txt`, r.source, "text/plain; charset=utf-8");
                set.storageSourceHash = hash;
                uploaded++;
            }
        }
        if (Object.keys(set).length) await db.update(chapter).set(set).where(eq(chapter.id, r.id));
    });

    await db.update(novel).set({ storageSyncedAt: new Date() }).where(eq(novel.id, novelId));
    return uploaded;
}

/** Syncs one novel or all of them and records the outcome for the settings page. */
export async function runSync(db: DB, novelId?: number): Promise<StorageStatus | null> {
    const bucket = await openBucket(db);
    if (!bucket) return null;
    const { includeSources } = await storageConfig(db);
    const ids = novelId ? [novelId] : (await db.select({ id: novel.id }).from(novel)).map((r) => r.id);
    const previous = await getSetting(db, STORAGE_STATUS_KEY, STORAGE_STATUS_DEFAULTS);
    let uploaded = 0;
    let error: string | null = null;
    for (const id of ids) {
        try {
            uploaded += await syncNovel(db, bucket, id, includeSources);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }
    const status: StorageStatus = {
        lastRunAt: new Date().toISOString(),
        uploaded: novelId ? previous.uploaded + uploaded : uploaded,
        novels: novelId ? previous.novels : ids.length,
        error,
    };
    await setSetting(db, STORAGE_STATUS_KEY, status);
    if (error) throw new Error(error);
    return status;
}

/** Forgets what was uploaded, so the next sync sends everything again (e.g. after changing the bucket). */
export async function resetSyncState(db: DB): Promise<void> {
    await db.update(novel).set({ storageMetaHash: null, storageSyncedAt: null });
    await db.update(chapter).set({ storageHash: null, storageSourceHash: null });
}
