import "server-only";
import { db } from "@/db";
import { telegramToken } from "./instance";

let cached: { token: string; username: string | null; at: number } | undefined;

/** The bot's @username for t.me links: TELEGRAM_BOT_USERNAME, else asked from Telegram once an hour. */
export async function botUsername(): Promise<string | null> {
    if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, "");
    const token = await telegramToken(db);
    if (!token) return null;
    if (cached?.token === token && Date.now() - cached.at < 3600_000) return cached.username;
    try {
        const res = await fetch(`${process.env.TELEGRAM_API_ROOT || "https://api.telegram.org"}/bot${token}/getMe`, { signal: AbortSignal.timeout(4000) });
        const data = await res.json();
        cached = { token, username: data?.result?.username ?? null, at: Date.now() };
    } catch {
        // a failed lookup is retried after a minute, not an hour
        cached = { token, username: null, at: Date.now() - 3600_000 + 60_000 };
    }
    return cached.username;
}
