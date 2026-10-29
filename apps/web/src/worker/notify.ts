import type { novel } from "@/db/schema";

type Novel = typeof novel.$inferSelect;

/** Where the run reports things a human should know about. */
export interface Notifier {
    decisionsNeeded(n: Novel, chapter: number): Promise<void>;
    chapterFailed(n: Novel, chapter: number, reason: string): Promise<void>;
    runHalted(n: Novel, reason: string): Promise<void>;
    finished(n: Novel): Promise<void>;
}

export const silentNotifier: Notifier = {
    async decisionsNeeded() {},
    async chapterFailed() {},
    async runHalted() {},
    async finished() {},
};

/** Calls every notifier, a failing channel never breaks the run. */
export function combine(...notifiers: Notifier[]): Notifier {
    const all =
        (name: keyof Notifier) =>
        async (...args: any[]) => {
            for (const n of notifiers) {
                try {
                    await (n[name] as (...a: any[]) => Promise<void>)(...args);
                } catch (error) {
                    console.error(`[notify] ${name} failed:`, error);
                }
            }
        };
    return {
        decisionsNeeded: all("decisionsNeeded"),
        chapterFailed: all("chapterFailed"),
        runHalted: all("runHalted"),
        finished: all("finished"),
    };
}
