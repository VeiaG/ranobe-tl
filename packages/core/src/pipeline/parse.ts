import { z } from "zod";
import { TERM_TYPES } from "../glossary/store";
import type { ProposedTerm } from "../glossary/glossary";

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

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const digits = (text: string) => (text.match(/\d+/g) ?? []).join(" ");

/**
 * The translated title when the model put it at the start of <translation> instead of a <title> block:
 * the first line of the translation, if it stands for the first line of the source (the title). It must carry
 * the same numbers ("Chapter 12"), be not much longer than the title, and the translation must have as many
 * lines as the source with its title.
 */
export function leadingTitle(source: string, translation: string): { title: string; content: string } | undefined {
    const src = lines(source);
    const out = lines(translation);
    if (src.length < 2 || out.length < 2) return undefined;
    const head = src[0];
    const first = out[0];
    if (digits(first) !== digits(head)) return undefined;
    // translations run longer or shorter than the source as a whole (CJK sources are much shorter)
    const ratio = translation.length / Math.max(1, source.length);
    if (first.length > Math.min(300, head.length * ratio * 2.5 + 20)) return undefined;
    // the title is one of the source lines: without it the translation would have a line less.
    // Unsure (a model merged two lines) means no: better a title left in the text than a paragraph lost.
    if (out.length < src.length) return undefined;
    const content = translation.trim().slice(translation.trim().indexOf(first) + first.length).trim();
    return content ? { title: first, content } : undefined;
}

/**
 * Title and text of a translated chapter. Without a translated title the source's first line stands in,
 * unless the model left the translated title at the start of the text: then it is taken from there.
 */
export function chapterTitle(source: string, title: string | undefined, content: string): { title: string; content: string } {
    if (title?.trim()) return { title: title.trim(), content };
    return leadingTitle(source, content) ?? { title: lines(source)[0] ?? "", content };
}
