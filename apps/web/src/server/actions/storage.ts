"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { requestFullSync } from "@/server/queue";
import { requireAdmin, requireUser } from "@/server/session";
import { setSetting } from "@/server/settings";
import { Bucket, STORAGE_KEY, openBucket, storageConfig } from "@/server/storage/client";
import { filesFromBucket, importNovelFolder } from "@/server/storage/import";
import { resetSyncState } from "@/server/storage/sync";
import { action } from "./util";

const StorageInput = z.object({
    enabled: z.boolean(),
    endpoint: z.string().trim().url("The endpoint must be a URL").or(z.literal("")),
    region: z.string().trim().default("auto"),
    bucket: z.string().trim(),
    accessKeyId: z.string().trim(),
    /** Empty keeps the saved secret. */
    secret: z.string().default(""),
    prefix: z.string().trim().default("ranobe-tl"),
    includeSources: z.boolean(),
});
export type StorageInput = z.input<typeof StorageInput>;

export async function saveStorage(input: StorageInput) {
    return action(async () => {
        await requireAdmin();
        const data = StorageInput.parse(input);
        const current = await storageConfig(db);
        const secretEncrypted = data.secret ? encrypt(data.secret) : current.secretEncrypted;
        if (data.enabled && (!data.endpoint || !data.bucket || !data.accessKeyId || !secretEncrypted)) {
            throw new Error("Endpoint, bucket, access key and secret are needed to turn backups on");
        }
        const moved = current.endpoint !== data.endpoint || current.bucket !== data.bucket || current.prefix !== data.prefix;
        await setSetting(db, STORAGE_KEY, {
            enabled: data.enabled,
            endpoint: data.endpoint,
            region: data.region || "auto",
            bucket: data.bucket,
            accessKeyId: data.accessKeyId,
            secretEncrypted,
            prefix: data.prefix.replace(/^\/+|\/+$/g, ""),
            includeSources: data.includeSources,
        });
        // a new place starts empty: upload everything there
        if (moved) await resetSyncState(db);
        if (data.enabled) await requestFullSync();
        revalidatePath("/settings");
        return { ok: true as const, message: data.enabled ? "Saved, a full sync is queued" : "Saved" };
    });
}

/** Writes, reads back and deletes a small file with the given (or saved) credentials. */
export async function testStorage(input: StorageInput) {
    return action(async () => {
        await requireAdmin();
        const data = StorageInput.parse(input);
        const current = await storageConfig(db);
        const secret = data.secret || (current.secretEncrypted ? decrypt(current.secretEncrypted) : "");
        if (!data.endpoint || !data.bucket || !data.accessKeyId || !secret) throw new Error("Fill in the endpoint, bucket, access key and secret");
        const bucket = new Bucket({ ...data, region: data.region || "auto" }, secret);
        const probe = `.ranobe-tl-check-${Date.now()}.txt`;
        const started = Date.now();
        await bucket.put(probe, "ok", "text/plain");
        const back = await bucket.get(probe);
        await bucket.delete(probe);
        if (!back || new TextDecoder().decode(back) !== "ok") throw new Error("The file was written but could not be read back");
        return { ok: true as const, message: `Bucket works: write, read and delete in ${Date.now() - started} ms` };
    });
}

export async function syncNow() {
    return action(async () => {
        await requireUser();
        if (!(await storageConfig(db)).enabled) throw new Error("Backups are off");
        await requestFullSync();
        return { ok: true as const, message: "Sync queued: the worker uploads what changed" };
    });
}

/** Novel folders in the bucket, for importing one back. */
export async function listBucketFolders() {
    return action(async () => {
        await requireUser();
        const bucket = await openBucket(db);
        if (!bucket) throw new Error("Set up backups in Settings → Storage first");
        const { folders } = await bucket.list("", "/");
        return folders.map((f) => f.replace(/\/$/, "")).filter(Boolean);
    });
}

export async function importFromBucket(folder: string, opts: { title?: string; providerKeyId?: number | null }) {
    return action(async () => {
        const user = await requireUser();
        const bucket = await openBucket(db);
        if (!bucket) throw new Error("Set up backups in Settings → Storage first");
        const files = await filesFromBucket(bucket, folder);
        if (!files.size) throw new Error(`Nothing found in ${folder}/`);
        const res = await importNovelFolder(db, files, { ...opts, createdBy: user.id, fallbackTitle: folder });
        revalidatePath("/", "layout");
        return res;
    });
}
