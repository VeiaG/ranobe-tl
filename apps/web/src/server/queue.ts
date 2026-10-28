import { PgBoss } from "pg-boss";
import { databaseUrl } from "@/db";

export const TRANSLATE_QUEUE = "translate-chapter";

export interface TranslateJob {
    novelId: number;
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
            schedule: false,
        });
        boss.on("error", (error) => console.error("[pg-boss]", error));
        await boss.start();
        await boss.createQueue(TRANSLATE_QUEUE, {
            policy: "stately",
            // a chapter with retries can take long; a dead worker is detected by the missing heartbeat instead
            expireInSeconds: 6 * 3600,
            heartbeatSeconds: 60,
            retryLimit: 3,
            retryDelay: 30,
        }).catch((error) => {
            // createQueue is not idempotent on every version
            if (!/exists/i.test(String(error))) throw error;
        });
        return boss;
    })();
    return globalForBoss.boss;
}

export async function enqueueNovel(novelId: number, role: "web" | "worker" = "web"): Promise<void> {
    const boss = await getBoss(role);
    await boss.send(TRANSLATE_QUEUE, { novelId } satisfies TranslateJob, { singletonKey: String(novelId) });
}
