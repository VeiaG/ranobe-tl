import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { DB } from "@/db";
import { chapter, novel, telegramLink, termChange } from "@/db/schema";
import { appUrl, escapeHtml } from "@/lib/html";
import { decide, pendingGroups, type PendingGroup } from "@/server/decisions";
import type { Notifier } from "./notify";

type Novel = typeof novel.$inferSelect;
type Flag = "notifyDecisions" | "notifyFailures" | "notifyFinished";

/** More groups than this in one notification are summarized with a link to the app. */
const MAX_GROUPS_PER_MESSAGE = 8;
/** Telegram limits callback data to 64 bytes: "<action>:<changeId>". */
const ACTIONS = { keep: "k", use: "u", custom: "c", remove: "r" } as const;

const GENDER_LABEL: Record<string, string> = { m: "male", f: "female", unknown: "unknown" };

export function createTelegram(db: DB, token: string): { bot: Bot; notifier: Notifier } {
    const bot = new Bot(token);
    /** chat id → change id of the group waiting for a typed translation */
    const awaitingCustom = new Map<string, number>();

    async function recipients(flag: Flag): Promise<string[]> {
        const rows = await db
            .select({ chatId: telegramLink.chatId })
            .from(telegramLink)
            .where(and(isNotNull(telegramLink.chatId), eq(telegramLink[flag], true)));
        return rows.map((r) => r.chatId!);
    }

    async function linkedChat(ctx: Context): Promise<typeof telegramLink.$inferSelect | undefined> {
        const chatId = ctx.chat?.id;
        if (!chatId) return undefined;
        const [link] = await db.select().from(telegramLink).where(eq(telegramLink.chatId, String(chatId)));
        return link;
    }

    async function broadcast(flag: Flag, text: string, keyboard?: InlineKeyboard) {
        for (const chatId of await recipients(flag)) {
            await bot.api.sendMessage(chatId, text, {
                parse_mode: "HTML",
                reply_markup: keyboard,
                link_preview_options: { is_disabled: true },
            });
        }
    }

    async function sendGroups(chatIds: string[], groups: PendingGroup[], header: string) {
        const shown = groups.slice(0, MAX_GROUPS_PER_MESSAGE);
        for (const chatId of chatIds) {
            await bot.api.sendMessage(chatId, header, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
            for (const g of shown) {
                await bot.api.sendMessage(chatId, describeGroup(g), { parse_mode: "HTML", reply_markup: groupKeyboard(g) });
            }
            if (groups.length > shown.length) {
                await bot.api.sendMessage(
                    chatId,
                    `…and ${groups.length - shown.length} more: <a href="${appUrl("/decisions")}">open the app</a>`,
                    { parse_mode: "HTML" }
                );
            }
        }
    }

    const notifier: Notifier = {
        async decisionsNeeded(n, chapterIndex) {
            const chatIds = await recipients("notifyDecisions");
            if (!chatIds.length) return;
            const groups = (await pendingGroups(db, n.id)).filter((g) => g.changes.some((c) => c.chapter === chapterIndex));
            if (!groups.length) return;
            const waiting = n.decisionMode === "pause" ? " The novel waits for your answer." : "";
            await sendGroups(
                chatIds,
                groups,
                `📖 <b>${escapeHtml(n.title)}</b> · chapter ${chapterIndex}\n${groups.length} glossary ${groups.length === 1 ? "change needs" : "changes need"} a decision.${waiting}`
            );
        },
        async chapterFailed(n, chapterIndex, reason) {
            await broadcast(
                "notifyFailures",
                `⚠️ <b>${escapeHtml(n.title)}</b> · chapter ${chapterIndex} failed\n<i>${escapeHtml(reason.slice(0, 600))}</i>`
            );
        },
        async runHalted(n, reason) {
            await broadcast(
                "notifyFailures",
                `⛔ <b>${escapeHtml(n.title)}</b> stopped\n${escapeHtml(reason.slice(0, 600))}\n<a href="${appUrl(`/novels/${n.id}`)}">Open</a>`
            );
        },
        async finished(n) {
            const [stats] = await db
                .select({
                    done: sql<number>`count(*) filter (where ${chapter.status} = 'done')::int`,
                    total: sql<number>`count(*)::int`,
                })
                .from(chapter)
                .where(eq(chapter.novelId, n.id));
            await broadcast(
                "notifyFinished",
                `✅ <b>${escapeHtml(n.title)}</b>: run finished, ${stats.done}/${stats.total} chapters translated.\n<a href="${appUrl(`/novels/${n.id}`)}">Open</a>`
            );
        },
    };

    bot.command("start", async (ctx) => {
        const token = ctx.match?.trim();
        if (!token) {
            const link = await linkedChat(ctx);
            await ctx.reply(
                link
                    ? "This chat is linked. You will get glossary decisions and run updates here. /pending shows what waits for you."
                    : `Open <b>Settings → Telegram</b> in the app and use the link from there to connect this chat.`,
                { parse_mode: "HTML" }
            );
            return;
        }
        const [link] = await db.select().from(telegramLink).where(eq(telegramLink.linkToken, token));
        if (!link) {
            await ctx.reply("This link is not valid any more. Create a new one in Settings → Telegram.");
            return;
        }
        await db
            .update(telegramLink)
            .set({ chatId: String(ctx.chat.id), username: ctx.from?.username ?? null, linkToken: null, linkedAt: new Date() })
            .where(eq(telegramLink.userId, link.userId));
        await ctx.reply("Linked ✓ Glossary decisions and run updates will come here.\n/pending: decisions waiting now\n/status: novels");
    });

    bot.command("pending", async (ctx) => {
        if (!(await linkedChat(ctx))) return void (await ctx.reply("This chat is not linked."));
        const groups = await pendingGroups(db);
        if (!groups.length) return void (await ctx.reply("Nothing waits for a decision 🎉"));
        await sendGroups([String(ctx.chat.id)], groups, `${groups.length} glossary ${groups.length === 1 ? "change waits" : "changes wait"} for a decision.`);
    });

    bot.command("status", async (ctx) => {
        if (!(await linkedChat(ctx))) return void (await ctx.reply("This chat is not linked."));
        const rows = await db
            .select({
                id: novel.id,
                title: novel.title,
                status: novel.status,
                message: novel.statusMessage,
                done: sql<number>`(select count(*) from chapter c where c.novel_id = "novel"."id" and c.status = 'done')::int`,
                total: sql<number>`(select count(*) from chapter c where c.novel_id = "novel"."id")::int`,
            })
            .from(novel)
            .orderBy(novel.title);
        if (!rows.length) return void (await ctx.reply("No novels yet."));
        const icon: Record<string, string> = { running: "▶️", waiting: "⏳", paused: "⏸", error: "⛔", idle: "•" };
        await ctx.reply(
            rows
                .map((r) => `${icon[r.status] ?? "•"} <b>${escapeHtml(r.title)}</b> ${r.done}/${r.total}${r.message ? `\n   <i>${escapeHtml(r.message)}</i>` : ""}`)
                .join("\n"),
            { parse_mode: "HTML" }
        );
    });

    bot.on("callback_query:data", async (ctx) => {
        const link = await linkedChat(ctx);
        if (!link) return void (await ctx.answerCallbackQuery({ text: "This chat is not linked." }));
        const [action, rawId] = ctx.callbackQuery.data.split(":");
        const [change] = await db.select().from(termChange).where(eq(termChange.id, Number(rawId)));
        if (!change || change.status !== "pending") {
            await ctx.answerCallbackQuery({ text: "Already decided" });
            await ctx.editMessageReplyMarkup().catch(() => {});
            return;
        }
        if (action === ACTIONS.custom) {
            awaitingCustom.set(String(ctx.chat!.id), change.id);
            await ctx.answerCallbackQuery();
            await ctx.reply("Send the translation you want to use:", { reply_markup: { force_reply: true } });
            return;
        }
        const res = await decide(db, {
            novelId: change.novelId,
            termId: change.termId,
            field: change.field as "target" | "gender" | "new",
            useChangeId: action === ACTIONS.use ? change.id : null,
            remove: action === ACTIONS.remove,
            userId: link.userId,
        });
        if (res.removed) {
            await ctx.answerCallbackQuery({ text: "Removed" });
            await markDecided(ctx, "not a term, removed", res.resumed);
            return;
        }
        const confirmed = change.field === "new";
        await ctx.answerCallbackQuery({ text: confirmed ? "Confirmed" : res.applied === null ? "Kept" : "Applied" });
        await markDecided(ctx, confirmed ? "confirmed" : res.applied === null ? "kept the current value" : `→ ${res.applied}`, res.resumed);
    });

    bot.on("message:text", async (ctx) => {
        const key = String(ctx.chat.id);
        const changeId = awaitingCustom.get(key);
        if (!changeId) return;
        const link = await linkedChat(ctx);
        if (!link) return;
        awaitingCustom.delete(key);
        const [change] = await db.select().from(termChange).where(eq(termChange.id, changeId));
        if (!change || change.status !== "pending") return void (await ctx.reply("That change was already decided."));
        const res = await decide(db, {
            novelId: change.novelId,
            termId: change.termId,
            field: change.field === "new" ? "new" : "target",
            custom: ctx.message.text,
            userId: link.userId,
        });
        await ctx.reply(`✓ ${escapeHtml(res.term)} → <b>${escapeHtml(res.applied ?? "")}</b>${res.resumed ? "\n▶️ Translation resumed" : ""}`, {
            parse_mode: "HTML",
        });
    });

    bot.catch((error) => console.error("[telegram]", error.error));
    return { bot, notifier };
}

async function markDecided(ctx: Context, what: string, resumed: boolean) {
    const original = ctx.callbackQuery?.message;
    const text = original && "text" in original ? original.text : "";
    await ctx
        .editMessageText(`${escapeHtml(text ?? "")}\n\n✓ <b>${escapeHtml(what)}</b>${resumed ? "\n▶️ Translation resumed" : ""}`, {
            parse_mode: "HTML",
        })
        .catch(() => {});
}

function describeGroup(g: PendingGroup): string {
    const t = g.term;
    if (g.field === "new") {
        const c = g.changes[0];
        const gender = t.type === "person" && g.gender ? `, ${GENDER_LABEL[g.gender] ?? g.gender}` : "";
        const lines = [
            `🆕 <b>${escapeHtml(t.source)}</b> → <b>${escapeHtml(t.target)}</b> <i>[${escapeHtml(t.type)}${gender}]</i>`,
            `<i>${escapeHtml(g.novelTitle)} · new term, chapter ${c.chapter ?? t.firstChapter ?? "?"}</i>`,
        ];
        if (c.reason) lines.push(escapeHtml(c.reason));
        if (c.evidence) lines.push(`“${escapeHtml(c.evidence)}”`);
        return lines.join("\n");
    }
    const head = `<b>${escapeHtml(t.source)}</b> → ${escapeHtml(t.target)} <i>[${escapeHtml(t.type)}${t.note ? `, ${escapeHtml(t.note)}` : ""}]</i>`;
    const now =
        g.field === "target"
            ? `translation now: <b>${escapeHtml(t.target)}</b>`
            : `gender now: <b>${escapeHtml(GENDER_LABEL[g.changes[0].oldValue] ?? g.changes[0].oldValue)}</b>`;
    const proposals = g.changes
        .map((c) => {
            const value = g.field === "gender" ? (GENDER_LABEL[c.newValue] ?? c.newValue) : c.newValue;
            const lines = [`• <b>${escapeHtml(value)}</b> <i>ch. ${c.chapter ?? "?"}</i>`];
            if (c.reason) lines.push(`  ${escapeHtml(c.reason)}`);
            if (c.evidence) lines.push(`  “${escapeHtml(c.evidence)}”`);
            return lines.join("\n");
        })
        .join("\n");
    return `${head}\n<i>${escapeHtml(g.novelTitle)}</i>\n${now}\n\nproposed:\n${proposals}`;
}

function groupKeyboard(g: PendingGroup): InlineKeyboard {
    const kb = new InlineKeyboard();
    if (g.field === "new") {
        const id = g.changes[0].id;
        return kb
            .text("✓ Looks right", `${ACTIONS.keep}:${id}`)
            .text("✏️ My own", `${ACTIONS.custom}:${id}`)
            .row()
            .text("🗑 Not a term", `${ACTIONS.remove}:${id}`);
    }
    const seen = new Set<string>();
    for (const c of g.changes) {
        if (seen.has(c.newValue)) continue;
        seen.add(c.newValue);
        const label = g.field === "gender" ? (GENDER_LABEL[c.newValue] ?? c.newValue) : c.newValue;
        kb.text(`✓ ${label}`.slice(0, 60), `${ACTIONS.use}:${c.id}`).row();
    }
    kb.text("Keep current", `${ACTIONS.keep}:${g.changes[0].id}`);
    if (g.field === "target") kb.text("✏️ My own", `${ACTIONS.custom}:${g.changes[0].id}`);
    return kb;
}
