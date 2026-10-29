/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A link into the app, or nothing when APP_URL is not set (the worker cannot know the address). */
export function appLink(path: string, label: string): string {
    const base = (process.env.APP_URL || process.env.BETTER_AUTH_URL || "").replace(/\/$/, "");
    return base ? `<a href="${base}${path}">${label}</a>` : "";
}
