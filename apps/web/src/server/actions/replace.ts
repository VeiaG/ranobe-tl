"use server";

import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { chapter } from "@/db/schema";
import { MAX_PATTERN_LENGTH, buildRegex, makeSnippet, replaceAll } from "@/lib/text-replace";
import { requestSync } from "@/server/queue";
import { requireUser } from "@/server/session";
import { keepVersion } from "@/server/versions";
import { action } from "./util";

const Input = z.object({
    find: z.string().min(1, "Enter what to find"),
    /** Empty deletes the matches. */
    replace: z.string().default(""),
    useRegex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    /** Adjust the replacement to the case of each match; meaningless when the case must match anyway. */
    preserveCase: z.boolean().default(false),
    inTitles: z.boolean().default(true),
    inContent: z.boolean().default(true),
    dryRun: z.boolean(),
});
export type ReplaceInput = z.input<typeof Input>;

export interface ReplaceMatch {
    index: number;
    title: string;
    count: number;
    /** Set when the title changes. */
    titleAfter: string | null;
    /** Around the first match in the text, before and after. */
    before: string | null;
    after: string | null;
}

/** Chapters listed in the preview; the totals count all of them. */
const PREVIEW_LIMIT = 300;

/** Find and replace over the translated chapters of a novel. A dry run only reports; applying keeps each old text in the chapter's history. */
export async function replaceInChapters(novelId: number, input: ReplaceInput) {
    return action(async () => {
        await requireUser();
        const o = Input.parse(input);
        if (!o.inTitles && !o.inContent) throw new Error("Choose titles, text or both");
        if (o.useRegex && o.find.length > MAX_PATTERN_LENGTH) throw new Error(`The pattern is too long (at most ${MAX_PATTERN_LENGTH} characters)`);
        let regex: RegExp;
        try {
            regex = buildRegex(o.find, o.useRegex, o.caseSensitive);
        } catch {
            throw new Error("Not a valid regular expression");
        }
        const options = { useRegex: o.useRegex, preserveCase: !o.caseSensitive && o.preserveCase };

        const rows = await db
            .select()
            .from(chapter)
            .where(and(eq(chapter.novelId, novelId), eq(chapter.status, "done")))
            .orderBy(asc(chapter.index));

        const matches: ReplaceMatch[] = [];
        let total = 0;
        let changed = 0;
        for (const c of rows) {
            const title = c.title ?? "";
            const content = c.content ?? "";
            const t = o.inTitles ? replaceAll(title, regex, o.replace, options) : null;
            const b = o.inContent ? replaceAll(content, regex, o.replace, options) : null;
            const count = (t?.count ?? 0) + (b?.count ?? 0);
            if (!count) continue;
            total += count;
            changed++;
            if (matches.length < PREVIEW_LIMIT) {
                matches.push({
                    index: c.index,
                    title,
                    count,
                    titleAfter: t?.count ? t.text : null,
                    // the text before the first match is unchanged, so the position holds in the new text too
                    before: b?.count ? makeSnippet(content, b.firstIndex, b.firstMatchLength) : null,
                    after: b?.count ? makeSnippet(b.text, b.firstIndex, b.firstReplacementLength) : null,
                });
            }
            if (!o.dryRun) {
                await keepVersion(db, c, "replace");
                await db
                    .update(chapter)
                    .set({ title: t?.count ? t.text : c.title, content: b?.count ? b.text : c.content })
                    .where(eq(chapter.id, c.id));
            }
        }
        if (!o.dryRun && changed) {
            revalidatePath(`/novels/${novelId}`, "layout");
            await requestSync(novelId);
        }
        return { dryRun: o.dryRun, matches, total, changed };
    });
}
