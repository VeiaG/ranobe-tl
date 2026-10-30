import type { ChangeField } from "@ranobe-tl/core";
import { PgBoss } from "pg-boss";
import { databaseUrl } from "@/db";

export const TRANSLATE_QUEUE = "translate-chapter";

export interface TranslateJob {
    novelId: number;
}

/** Uploads one novel's folder to the backup bucket; queued with a delay so bursts of changes make one upload. */
export const SYNC_NOVEL_QUEUE = "storage-sync-novel";
/** Checks every novel; runs nightly and on "Sync now". */
export const SYNC_ALL_QUEUE = "storage-sync-all";
const SYNC_DELAY_SECONDS = 60;
/** A glossary decision was made: the worker closes the Telegram messages still showing its buttons. */
export const DECIDED_QUEUE = "decision-made";

export interface DecidedJob {
    termId: number;
    field: ChangeField;
    /** What was decided, e.g. "→ Вежа Неба" or "kept the current value". */
    what: string;
    resumed: boolean;
    /** Messages sent after this are about newer proposals and stay open. */
    decidedAt: string;
}

/** Checks one Message Batch at the provider; re-queued with a delay until the batch ends. */
export const BATCH_POLL_QUEUE = "batch-poll";
const BATCH_POLL_SECONDS = 60;

export interface BatchPollJob {
    batchJobId: number;
}

const globalForBoss = globalThis as unknown as { boss?: Promise<PgBoss> };

/**
 * One job translates one chapter of a novel and queues the next one.
 * "stately" + singletonKey = novel: at most one active and one queued job per novel,
 * so a novel is always translated in order while different novels run in parallel.
 */
export function getBoss(role: "web" | "worker" = "web"): Promise<PgBoss> {
    globalForBoss.boss ??= (async () => {
        const boss = new PgBoss({
            connectionString: databaseUrl(),
            schema: "pgboss",
            supervise: role === "worker",
            schedule: role === "worker",
        });
        boss.on("error", (error) => console.error("[pg-boss]", error));
        await boss.start();
        const create = (name: string, options: Parameters<PgBoss["createQueue"]>[1]) =>
            boss.createQueue(name, options).catch((error) => {
                // createQueue is not idempotent on every version
                if (!/exists/i.test(String(error))) throw error;
            });
        await create(TRANSLATE_QUEUE, {
            policy: "stately",
            // a chapter with retries can take long; a dead worker is detected by the missing heartbeat instead
            expireInSeconds: 6 * 3600,
            heartbeatSeconds: 60,
            retryLimit: 3,
            retryDelay: 30,
        });
        // "stately": while one sync of a novel waits, more requests for it are dropped (a debounce)
        await create(SYNC_NOVEL_QUEUE, { policy: "stately", expireInSeconds: 3600, retryLimit: 3, retryDelay: 120, retryBackoff: true });
        await create(SYNC_ALL_QUEUE, { policy: "stately", expireInSeconds: 6 * 3600, retryLimit: 1 });
        // "stately" + singletonKey = batch: one waiting poll per batch however often it is requested
        await create(BATCH_POLL_QUEUE, { policy: "stately", expireInSeconds: 3600, retryLimit: 5, retryDelay: 60, retryBackoff: true });
        await create(DECIDED_QUEUE, { expireInSeconds: 600, retryLimit: 2, retryDelay: 10, deleteAfterSeconds: 24 * 3600 });
        return boss;
    })();
    return globalForBoss.boss;
}

export async function enqueueNovel(novelId: number, role: "web" | "worker" = "web", delaySeconds = 0): Promise<void> {
    const boss = await getBoss(role);
    await boss.send(TRANSLATE_QUEUE, { novelId } satisfies TranslateJob, { singletonKey: String(novelId), ...(delaySeconds ? { startAfter: delaySeconds } : {}) });
}

export async function enqueueBatchPoll(batchJobId: number, role: "web" | "worker" = "web", delaySeconds = BATCH_POLL_SECONDS): Promise<void> {
    const boss = await getBoss(role);
    await boss.send(BATCH_POLL_QUEUE, { batchJobId } satisfies BatchPollJob, { singletonKey: String(batchJobId), ...(delaySeconds ? { startAfter: delaySeconds } : {}) });
}

/** Asks for a backup upload of the novel soon, if a bucket is set up. Never throws: a backup must not break an edit. */
export async function requestSync(novelId: number, role: "web" | "worker" = "web"): Promise<void> {
    try {
        const { db } = await import("@/db");
        const { storageConfig } = await import("./storage/client");
        if (!(await storageConfig(db)).enabled) return;
        const boss = await getBoss(role);
        await boss.send(SYNC_NOVEL_QUEUE, { novelId } satisfies TranslateJob, { singletonKey: String(novelId), startAfter: SYNC_DELAY_SECONDS });
    } catch (error) {
        console.error("[storage] could not queue a sync:", error);
    }
}

export async function requestFullSync(): Promise<void> {
    const boss = await getBoss("web");
    await boss.send(SYNC_ALL_QUEUE, {}, { singletonKey: "all" });
}

/** Tells the worker a decision was made. Never throws: a stale Telegram button must not break a decision. */
export async function announceDecision(job: Omit<DecidedJob, "decidedAt">, role: "web" | "worker" = "web"): Promise<void> {
    try {
        const boss = await getBoss(role);
        await boss.send(DECIDED_QUEUE, { ...job, decidedAt: new Date().toISOString() } satisfies DecidedJob);
    } catch (error) {
        console.error("[telegram] could not queue a decision update:", error);
    }
}
