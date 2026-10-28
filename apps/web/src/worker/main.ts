import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { novel } from "@/db/schema";
import { SYNC_ALL_QUEUE, SYNC_NOVEL_QUEUE, TRANSLATE_QUEUE, enqueueNovel, getBoss, type TranslateJob } from "@/server/queue";
import { runSync } from "@/server/storage/sync";
import { combine, silentNotifier, type Notifier } from "./notify";
import { translateNext } from "./run";
import { createTelegram } from "./telegram";

/** How many novels translate at the same time on this worker. */
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2));

async function main() {
    if (process.env.SKIP_MIGRATIONS !== "1") await runMigrations();

    let notifier: Notifier = silentNotifier;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    let stopBot = async () => {};
    if (token) {
        const telegram = createTelegram(db, token);
        notifier = combine(telegram.notifier);
        // long polling: no public URL needed, works behind NAT (a Raspberry Pi at home)
        telegram.bot
            .start({
                drop_pending_updates: false,
                onStart: (me) => console.log(`[telegram] @${me.username} is listening`),
            })
            .catch((error) => console.error("[telegram] bot stopped:", error));
        stopBot = () => telegram.bot.stop();
    } else {
        console.log("[telegram] TELEGRAM_BOT_TOKEN is not set, notifications are off");
    }

    const boss = await getBoss("worker");
    await boss.work<TranslateJob>(TRANSLATE_QUEUE, { localConcurrency: CONCURRENCY, pollingIntervalSeconds: 2 }, async ([job]) => {
        const { novelId } = job.data;
        const outcome = await translateNext(db, novelId, notifier);
        if (outcome === "next") await enqueueNovel(novelId, "worker");
    });

    await boss.work<TranslateJob>(SYNC_NOVEL_QUEUE, async ([job]) => {
        await runSync(db, job.data.novelId);
    });
    await boss.work(SYNC_ALL_QUEUE, async () => {
        await runSync(db);
    });
    // nightly check of every novel, catches anything a debounced sync missed
    await boss.schedule(SYNC_ALL_QUEUE, process.env.BACKUP_CRON || "17 3 * * *", {}, { singletonKey: "all", tz: process.env.TZ || "UTC" });

    // Novels left "running" by a previous worker get their job back (stately keeps it to one per novel).
    const running = await db
        .select({ id: novel.id })
        .from(novel)
        .where(and(inArray(novel.status, ["running"]), eq(novel.stopRequested, false)));
    for (const n of running) await enqueueNovel(n.id, "worker");

    console.log(`[worker] ready: ${CONCURRENCY} novels in parallel${running.length ? `, resumed ${running.length}` : ""}`);

    const shutdown = async (signal: string) => {
        console.log(`[worker] ${signal}: finishing the chapters in flight…`);
        await stopBot().catch(() => {});
        await boss.stop({ graceful: true, timeout: 10 * 60 * 1000 });
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
