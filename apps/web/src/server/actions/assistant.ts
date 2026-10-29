"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { Edit, applyEdits } from "@/server/assistant";
import { requestSync } from "@/server/queue";
import { requireUser } from "@/server/session";
import { action } from "./util";

/** Writes the assistant's edits the user confirmed. */
export async function applyAssistantEdits(novelId: number, edits: Edit[]) {
    return action(async () => {
        await requireUser();
        const result = await applyEdits(db, novelId, z.array(Edit).parse(edits));
        if (result.applied.length) {
            revalidatePath(`/novels/${novelId}`, "layout");
            await requestSync(novelId);
        }
        return result;
    });
}
