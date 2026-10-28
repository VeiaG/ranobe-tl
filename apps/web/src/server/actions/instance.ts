"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { providerKey } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { INSTANCE_KEY, InstanceSchema, TELEGRAM_KEY, type InstanceConfig } from "@/server/instance";
import { requireAdmin } from "@/server/session";
import { setSetting } from "@/server/settings";
import { action } from "./util";

export async function saveInstance(input: InstanceConfig) {
    return action(async () => {
        await requireAdmin();
        await setSetting(db, INSTANCE_KEY, InstanceSchema.parse(input));
        revalidatePath("/settings");
        return { ok: true as const, message: "Saved; the worker uses it from the next chapter" };
    });
}

/** An empty token removes the one set here (TELEGRAM_BOT_TOKEN from the environment applies again). */
export async function saveTelegramToken(token: string) {
    return action(async () => {
        await requireAdmin();
        const t = token.trim();
        if (t && !/^\d+:[\w-]{20,}$/.test(t)) throw new Error("That does not look like a bot token from @BotFather (123456:ABC…)");
        await setSetting(db, TELEGRAM_KEY, t ? { tokenEncrypted: encrypt(t) } : {});
        revalidatePath("/settings");
        return { ok: true as const, message: t ? "Token saved; the worker starts the bot within half a minute" : "Token removed" };
    });
}

export async function setKeyParallel(id: number, maxParallel: number | null) {
    return action(async () => {
        await requireAdmin();
        if (maxParallel !== null && (!Number.isInteger(maxParallel) || maxParallel < 1)) throw new Error("Use a whole number from 1");
        await db.update(providerKey).set({ maxParallel }).where(eq(providerKey.id, id));
        revalidatePath("/settings");
    });
}
