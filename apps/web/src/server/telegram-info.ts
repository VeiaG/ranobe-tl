import "server-only";
import { db } from "@/db";
import { telegramToken } from "./instance";

let cached: { username: string | null; at: number } | undefined;

/** The bot's @username for t.me links: TELEGRAM_BOT_USERNAME, else asked from Telegram once an hour. */
export async function botUsername(): Promise<string | null> {
    if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, "");
    const token = await telegramToken(db);
    if (!token) return null;
    if (cached && Date.now() - cached.at < 3600_000) return cached.username;
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(4000) });
        const data = await res.json();
        cached = { username: data?.result?.username ?? null, at: Date.now() };
    } catch {
        cached = { username: null, at: Date.now() };
    }
    return cached.username;
}
