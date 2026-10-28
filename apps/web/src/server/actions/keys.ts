"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generateText } from "ai";
import { PROVIDERS, createModel, parseConfig, resolveModelId, type Provider } from "@ranobe-tl/core";
import { db } from "@/db";
import { providerKey } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { requireAdmin, requireUser } from "@/server/session";
import { action } from "./util";

export async function addKey(input: { name: string; provider: string; apiKey: string; baseURL?: string }) {
    return action(async () => {
        const user = await requireAdmin();
        if (!(PROVIDERS as readonly string[]).includes(input.provider)) throw new Error("Unknown provider");
        const apiKey = input.apiKey.trim();
        if (apiKey.length < 8) throw new Error("The key looks too short");
        await db.insert(providerKey).values({
            name: input.name.trim() || input.provider,
            provider: input.provider,
            baseURL: input.baseURL?.trim() || null,
            encryptedKey: encrypt(apiKey),
            hint: apiKey.slice(-4),
            createdBy: user.id,
        });
        revalidatePath("/settings");
    });
}

export async function deleteKey(id: number) {
    return action(async () => {
        await requireAdmin();
        await db.delete(providerKey).where(eq(providerKey.id, id));
        revalidatePath("/settings");
    });
}

/** Sends a tiny request with the key to check it works. */
export async function testKey(id: number, model?: string) {
    return action(async () => {
        await requireUser();
        const [key] = await db.select().from(providerKey).where(eq(providerKey.id, id));
        if (!key) throw new Error("Key not found");
        const config = parseConfig({ provider: key.provider as Provider, model: model || undefined, baseURL: key.baseURL ?? undefined });
        const setup = createModel(config, decrypt(key.encryptedKey));
        const started = Date.now();
        const res = await generateText({
            model: setup.model,
            prompt: "Reply with the single word: ok",
            maxOutputTokens: 1000,
            maxRetries: 0,
            providerOptions: setup.providerOptions,
        });
        return { ok: true as const, message: `${resolveModelId(config)} answered "${res.text.trim().slice(0, 40)}" in ${((Date.now() - started) / 1000).toFixed(1)}s` };
    });
}

export async function setKeyBudget(id: number, monthlyBudgetUsd: number | null) {
    return action(async () => {
        await requireAdmin();
        if (monthlyBudgetUsd !== null && (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 0)) throw new Error("The budget must be a positive number");
        await db.update(providerKey).set({ monthlyBudgetUsd }).where(eq(providerKey.id, id));
        revalidatePath("/settings");
        return { ok: true as const, message: monthlyBudgetUsd === null ? "Budget removed" : "Monthly budget saved" };
    });
}
