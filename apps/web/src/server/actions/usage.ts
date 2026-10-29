"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { DEFAULT_PRICES, PRICES_KEY } from "@/server/pricing";
import { requireAdmin } from "@/server/session";
import { setSetting } from "@/server/settings";
import { action } from "./util";

const PriceSchema = z.object({ input: z.number().min(0), cachedInput: z.number().min(0), output: z.number().min(0) });

/** Saves prices that differ from the defaults; a model cleared of all prices loses its custom entry. */
export async function savePrices(prices: Record<string, z.input<typeof PriceSchema> | null>) {
    return action(async () => {
        await requireAdmin();
        const custom: Record<string, z.infer<typeof PriceSchema>> = {};
        for (const [model, p] of Object.entries(prices)) {
            if (!p || !model.trim()) continue;
            const price = PriceSchema.parse(p);
            const d = DEFAULT_PRICES[model];
            if (d && d.input === price.input && d.cachedInput === price.cachedInput && d.output === price.output) continue;
            custom[model.trim()] = price;
        }
        await setSetting(db, PRICES_KEY, custom);
        revalidatePath("/usage");
        return { ok: true as const, message: "Prices saved" };
    });
}
