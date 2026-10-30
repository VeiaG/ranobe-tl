import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { batchJob, novel } from "@/db/schema";
import { pollBatch } from "@/server/batch/ingest";
import {
    BATCH_POLL_QUEUE,
    DECIDED_QUEUE,
    SYNC_ALL_QUEUE,
    SYNC_NOVEL_QUEUE,
    TRANSLATE_QUEUE,
    enqueueBatchPoll,
    enqueueNovel,
    getBoss,
    type BatchPollJob,
    type DecidedJob,
    type TranslateJob,
} from "@/server/queue";
import { runSync } from "@/server/storage/sync";
import { instanceConfig, telegramToken } from "@/server/instance";
import { combine, type Notifier } from "./notify";
import { translateNext } from "./run";
import { createTelegram, type Telegram } from "./telegram";

/**
 * Job slots of this worker. The real limit of novels translating at once is set in
 * Settings → Instance (and per API key) and checked for every chapter, so it changes without a restart.
 */
const SLOTS = Math.max(1, Number(process.env.WORKER_SLOTS ?? 8));
/** How long a novel waits before trying again when every slot is busy. */
const DEFER_SECONDS = 15;
/** How often the worker checks whether the bot token was changed in the UI. */
const TOKEN_CHECK_MS = 30_000;

/** Runs the Telegram bot for the current token and restarts it when the token changes. */
function telegramController() {
    let current: { token: string; telegram: Telegram; stop: () => Promise<void> } | null = null;

    async function apply(token: string | null) {
        if (token === (current?.token ?? null)) return;
        if (current) {
            await current.stop().catch(() => {});
            current = null;
            console.log("[telegram] bot stopped");
        }
        if (!token) {
            console.log("[telegram] no bot token (Settings → Telegram or TELEGRAM_BOT_TOKEN), notifications are off");
            return;
        }
        const telegram = createTelegram(db, token);
        const self = { token, telegram, stop: () => telegram.bot.stop() };
        // long polling: no public URL needed, works behind NAT (a Raspberry Pi at home)
        telegram.bot
            .start({ drop_pending_updates: false, onStart: (me) => console.log(`[telegram] @${me.username} is listening`) })
            .catch((error) => {
                // 409: another process polls the same bot (the old container during a redeploy, a dev
                // copy, another app on this token). grammY gives up then; the next token check retries.
                const conflict = error?.error_code === 409;
                console.error(
                    conflict
                        ? "[telegram] another process is reading this bot's updates; retrying in 30 s (a bot token can be used by one app only)"
                        : "[telegram] bot stopped, retrying in 30 s:",
                    conflict ? "" : error
                );
                if (current === self) current = null;
            });
        current = self;
    }

    // the run keeps one notifier; it forwards to whichever bot is live
    const relay = (name: keyof Notifier) => async (...args: any[]) => {
        if (current) await (current.telegram.notifier[name] as (...a: any[]) => Promise<void>)(...args);
    };
    const notifier: Notifier = combine({
        decisionsNeeded: relay("decisionsNeeded"),
        chapterFailed: relay("chapterFailed"),
        runHalted: relay("runHalted"),
        finished: relay("finished"),
    });
    // without a bot there are no messages to close
    const decided = async (job: DecidedJob) => {
        if (current) await current.telegram.decided(job);
    };
    return { notifier, decided, apply, stop: () => current?.stop() ?? Promise.resolve() };
}

async function main() {
    if (process.env.SKIP_MIGRATIONS !== "1") await runMigrations();

    const telegram = telegramController();
    await telegram.apply(await telegramToken(db));
    const tokenTimer = setInterval(() => {
        telegramToken(db)
            .then((t) => telegram.apply(t))
            .catch((error) => console.error("[telegram] token check failed:", error));
    }, TOKEN_CHECK_MS);
    const notifier = telegram.notifier;
    const stopBot = async () => {
        clearInterval(tokenTimer);
        await telegram.stop();
    };

    const boss = await getBoss("worker");
    await boss.work<TranslateJob>(TRANSLATE_QUEUE, { localConcurrency: SLOTS, pollingIntervalSeconds: 2 }, async ([job]) => {
        const { novelId } = job.data;
        const outcome = await translateNext(db, novelId, notifier);
        if (outcome === "next") await enqueueNovel(novelId, "worker");
        if (outcome === "defer") await enqueueNovel(novelId, "worker", DEFER_SECONDS);
    });

    await boss.work<TranslateJob>(SYNC_NOVEL_QUEUE, async ([job]) => {
        await runSync(db, job.data.novelId);
    });
    await boss.work(SYNC_ALL_QUEUE, async () => {
        await runSync(db);
    });
    await boss.work<BatchPollJob>(BATCH_POLL_QUEUE, async ([job]) => {
        await pollBatch(db, job.data.batchJobId, notifier);
    });
    await boss.work<DecidedJob>(DECIDED_QUEUE, async ([job]) => {
        await telegram.decided(job.data);
    });
    // nightly check of every novel, catches anything a debounced sync missed
    await boss.schedule(SYNC_ALL_QUEUE, process.env.BACKUP_CRON || "17 3 * * *", {}, { singletonKey: "all", tz: process.env.TZ || "UTC" });

    // Novels left "running" by a previous worker get their job back (stately keeps it to one per novel).
    const running = await db
        .select({ id: novel.id })
        .from(novel)
        .where(and(inArray(novel.status, ["running"]), eq(novel.stopRequested, false), eq(novel.pipeline, "classic")));
    for (const n of running) await enqueueNovel(n.id, "worker");
    // open batches are polled again (a poll lost with the previous worker would leave them hanging)
    const batches = await db.select({ id: batchJob.id }).from(batchJob).where(inArray(batchJob.status, ["in_progress", "canceling"]));
    for (const b of batches) await enqueueBatchPoll(b.id, "worker", 5);

    const { concurrency } = await instanceConfig(db);
    console.log(`[worker] ready: up to ${concurrency} novels in parallel (${SLOTS} slots here)${running.length ? `, resumed ${running.length}` : ""}`);

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
