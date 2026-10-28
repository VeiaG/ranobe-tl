import { z } from "zod";
import { TERM_TYPES } from "../glossary/store.js";
import type { ProposedTerm } from "../glossary/glossary.js";

export interface ParsedOutput {
    title?: string;
    translation: string;
    terms: ProposedTerm[];
    problems: string[];
}

const TermSchema = z.object({
    source: z.string().min(1),
    target: z.string().default(""),
    type: z.string().transform((t) => ((TERM_TYPES as readonly string[]).includes(t) ? t : "other") as ProposedTerm["type"]).default("other"),
    gender: z.enum(["m", "f", "unknown"]).optional().catch(undefined),
    note: z.string().optional().catch(undefined),
    evidence: z.string().optional().catch(undefined),
});

function block(text: string, tag: string): string | undefined {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`));
    return m?.[1];
}

export function parseOutput(raw: string): ParsedOutput {
    const problems: string[] = [];
    const text = raw
        // reasoning models served through OpenAI-compatible APIs may prepend their thoughts
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, "");

    // The title must be one line; models sometimes pull subtitles or junk lines into it.
    const titleLines = (block(text, "title") ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const title = titleLines[0];
    const titleSpill = titleLines.slice(1).join("\n\n");
    let translation = block(text, "translation");
    if (translation === undefined) {
        problems.push("missing <translation> block");
        translation = "";
    } else if (!/<\/translation>/.test(text)) {
        problems.push("<translation> block is not closed (output truncated?)");
    }

    const terms: ProposedTerm[] = [];
    const termsRaw = block(text, "terms");
    if (termsRaw !== undefined && termsRaw.trim()) {
        try {
            const json = JSON.parse(termsRaw.trim().replace(/^```(?:json)?|```$/g, ""));
            for (const item of Array.isArray(json) ? json : []) {
                const parsed = TermSchema.safeParse(item);
                if (parsed.success) terms.push(parsed.data);
            }
        } catch {
            problems.push("<terms> is not valid JSON");
        }
    }

    const body = translation.trim();
    return {
        title: title || undefined,
        translation: titleSpill && body ? `${titleSpill}\n\n${body}` : body,
        terms,
        problems,
    };
}
