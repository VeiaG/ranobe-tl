"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { invite, telegramLink, user } from "@/db/schema";
import { randomToken } from "@/lib/crypto";
import { requireAdmin, requireUser } from "@/server/session";
import { action } from "./util";

export async function createInvite(note: string) {
    return action(async () => {
        const admin = await requireAdmin();
        const token = randomToken();
        await db.insert(invite).values({ token, note: note.trim(), createdBy: admin.id, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) });
        revalidatePath("/settings");
        return token;
    });
}

export async function revokeInvite(token: string) {
    return action(async () => {
        await requireAdmin();
        await db.delete(invite).where(eq(invite.token, token));
        revalidatePath("/settings");
    });
}

export async function removeUser(id: string) {
    return action(async () => {
        const admin = await requireAdmin();
        if (id === admin.id) throw new Error("You cannot remove yourself");
        await db.delete(user).where(and(eq(user.id, id), ne(user.role, "admin")));
        revalidatePath("/settings");
    });
}

/** A fresh /start token for linking the bot to this user. */
export async function createTelegramLink() {
    return action(async () => {
        const me = await requireUser();
        const token = randomToken(12);
        await db
            .insert(telegramLink)
            .values({ userId: me.id, linkToken: token })
            .onConflictDoUpdate({ target: telegramLink.userId, set: { linkToken: token } });
        revalidatePath("/settings");
        return token;
    });
}

export async function unlinkTelegram() {
    return action(async () => {
        const me = await requireUser();
        await db.delete(telegramLink).where(eq(telegramLink.userId, me.id));
        revalidatePath("/settings");
    });
}

export async function setTelegramNotifications(flags: { notifyDecisions?: boolean; notifyFailures?: boolean; notifyFinished?: boolean }) {
    return action(async () => {
        const me = await requireUser();
        await db.update(telegramLink).set(flags).where(eq(telegramLink.userId, me.id));
        revalidatePath("/settings");
    });
}
