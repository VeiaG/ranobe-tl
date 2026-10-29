"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generateText } from "ai";
import { PROVIDERS, createModel, parseConfig, resolveModelId, type Provider } from "@ranobe-tl/core";
import { db } from "@/db";
import { providerKey } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { getPrices, type Price } from "@/server/pricing";
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

export interface ModelOption {
    id: string;
    label?: string;
    price?: Price;
}

/** OpenAI lists every model it has; these never translate text. */
const NOT_FOR_TEXT = /embed|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|computer-use|davinci|babbage/i;

/**
 * Models the key can use, from the provider's own list (a local OpenAI-compatible server lists its models too).
 * If the provider does not answer, the models with a known price are offered instead.
 */
export async function listModels(keyId: number) {
    return action(async () => {
        await requireUser();
        const [key] = await db.select().from(providerKey).where(eq(providerKey.id, keyId));
        if (!key) throw new Error("Key not found");
        const prices = await getPrices(db);
        const apiKey = decrypt(key.encryptedKey);
        const signal = AbortSignal.timeout(8000);
        let ids: { id: string; label?: string }[] = [];
        let error: string | undefined;
        try {
            if (key.provider === "anthropic") {
                const base = key.baseURL || "https://api.anthropic.com/v1";
                const res = await fetch(`${base}/models?limit=1000`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as { data: { id: string; display_name?: string }[] };
                ids = data.data.map((m) => ({ id: m.id, label: m.display_name }));
            } else if (key.provider === "openai") {
                const base = key.baseURL || "https://api.openai.com/v1";
                const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as { data: { id: string }[] };
                ids = data.data.filter((m) => key.baseURL || !NOT_FOR_TEXT.test(m.id)).map((m) => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id));
            } else if (key.provider === "google") {
                const base = key.baseURL || "https://generativelanguage.googleapis.com/v1beta";
                const res = await fetch(`${base}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey }, signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as { models: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
                ids = data.models
                    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
                    .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName }));
            }
        } catch (e) {
            error = `the provider did not list its models (${e instanceof Error ? e.message : String(e)})`;
            const prefix = key.provider === "anthropic" ? "claude-" : key.provider === "openai" ? "gpt-" : "gemini-";
            ids = Object.keys(prices).filter((id) => id.startsWith(prefix)).map((id) => ({ id }));
        }
        const models: ModelOption[] = ids.map((m) => ({ ...m, price: prices[m.id] }));
        return { models, error };
    });
}
