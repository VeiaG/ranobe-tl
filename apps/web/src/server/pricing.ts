import type { DB } from "@/db";
import { getSetting } from "./settings";

/** USD per 1M tokens. `cachedInput` is what a cache read costs instead of `input`. */
export interface Price {
    input: number;
    cachedInput: number;
    output: number;
}

/**
 * Anthropic list prices (first-party API, cached 2026-10). Other providers change prices too often
 * to ship defaults: their models are listed with no price until one is set in Usage → Prices.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
    "claude-fable-5-1": { input: 10, cachedInput: 0.25, output: 50 },
    "claude-fable-5": { input: 10, cachedInput: 1, output: 50 },
    "claude-opus-5-5": { input: 4, cachedInput: 0.2, output: 20 },
    "claude-opus-5": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-8": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-7": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-6": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-sonnet-5-5": { input: 2, cachedInput: 0.2, output: 10 },
    "claude-sonnet-5": { input: 2, cachedInput: 0.2, output: 10 },
    "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, output: 15 },
    "claude-haiku-5-5": { input: 0.1, cachedInput: 0.01, output: 0.5 },
    "claude-haiku-4-5": { input: 1, cachedInput: 0.1, output: 5 },
};

export const PRICES_KEY = "prices";

/** Defaults with the user's prices on top (a user price always wins, including for Claude models). */
export async function getPrices(db: DB): Promise<Record<string, Price>> {
    const custom = await getSetting<Record<string, Price>>(db, PRICES_KEY, {});
    return { ...DEFAULT_PRICES, ...custom };
}

export interface Tokens {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
}

/** Usage of Message Batches is recorded under "<model>:batch": half the price of the model. */
export const BATCH_SUFFIX = ":batch";
const BATCH_DISCOUNT = 0.5;

/** The price of a recorded model name, batch requests included. */
export function priceOf(prices: Record<string, Price>, model: string): Price | undefined {
    if (!model.endsWith(BATCH_SUFFIX)) return prices[model];
    const base = prices[model.slice(0, -BATCH_SUFFIX.length)];
    return base && { input: base.input * BATCH_DISCOUNT, cachedInput: base.cachedInput * BATCH_DISCOUNT, output: base.output * BATCH_DISCOUNT };
}

/** Cost in USD, or null when the model has no price. */
export function costOf(t: Tokens, price: Price | undefined): number | null {
    if (!price) return null;
    const uncached = Math.max(0, t.inputTokens - t.cachedTokens);
    return (uncached * price.input + t.cachedTokens * price.cachedInput + t.outputTokens * price.output) / 1_000_000;
}

export function formatUsd(n: number | null | undefined, digits?: number): string {
    if (n === null || n === undefined) return "—";
    const d = digits ?? (n >= 100 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 3 : 4);
    return `$${n.toFixed(d)}`;
}
