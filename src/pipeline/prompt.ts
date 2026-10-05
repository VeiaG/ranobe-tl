import type { Config } from "../config.js";
import { TERM_TYPES, Term, genderAt } from "../glossary/store.js";

/**
 * Static part of the prompt. It must not depend on the chapter so that
 * providers can cache it (OpenAI caches identical prefixes automatically).
 */
export function systemPrompt(config: Config): string {
    const { sourceLanguage: from, targetLanguage: to } = config;
    const about = [
        config.novel.title && `Novel: ${config.novel.title}`,
        config.novel.synopsis && `Synopsis: ${config.novel.synopsis}`,
    ].filter(Boolean);
    return `You are a professional literary translator of web novels from ${from} to ${to}.
${about.length ? `\n${about.join("\n")}\n` : ""}
Translate the text inside <source> completely and faithfully: every paragraph, every line of dialogue, nothing summarized, nothing added. Keep the paragraph structure. Write natural, fluent ${to} prose that keeps the tone of the original.

## Glossary
The user message contains a glossary of terms found in this text, formatted as:
  source → translation [type, gender, note]
Use these translations consistently, declined/conjugated as ${to} grammar requires. The bracketed part is reference information only: never copy it into the translation. Gender tells you which grammatical gender to use for that character (m = male, f = female).

## Output format
Respond with exactly these blocks and nothing outside them:

<title>translated chapter title (one line: the first line of the source)</title>
<translation>
the full translated text, without the title
</translation>
<terms>
[JSON array, may be empty]
</terms>

Omit <title> when the user message says the text is a continuation chunk.
No markdown, no code fences, no commentary.

## <terms> block
List glossary entries that future chapters need for consistency:
- proper names (people, places, sects, clans, organizations), techniques, treasures, cultivation realms and ranks, unique creatures and coined terms;
- terms NOT in the provided glossary, or terms whose information changed.
Do NOT list common words or phrases with an obvious translation ("father", "home", "sword", "fourth uncle").
Do not list glossary terms you used unchanged.

Each item: {"source": "${from} term as in the text", "target": "${to} translation", "type": one of ${TERM_TYPES.map((t) => `"${t}"`).join(", ")}, "gender": "m" | "f" | "unknown" (persons only), "note": "optional short context", "evidence": "optional exact quote"}

Gender rules:
- For a new person set gender only if the text makes it clear (pronouns, titles); otherwise "unknown".
- If the text clearly shows a different gender than the glossary says (or reveals a gender listed as unknown), list the term again with the new gender and put an exact, verbatim quote from <source> proving it into "evidence".

If you believe a glossary translation is wrong, still use it in the text, but list the term with your suggested "target" and explain why in "note". A human will review it.${config.instructions ? `\n\n## Additional instructions\n${config.instructions}` : ""}`;
}

export function formatGlossary(terms: Term[], chapter: number): string {
    return terms
        .map((t) => {
            const info: string[] = [t.type];
            const g = genderAt(t, chapter);
            if (g) info.push(g);
            if (t.note) info.push(t.note);
            return `${t.source} → ${t.target} [${info.join(", ")}]`;
        })
        .join("\n");
}

export function userPrompt(opts: {
    text: string;
    terms: Term[];
    chapter: number;
    chunk: number;
    totalChunks: number;
    previousContext?: string;
    feedback?: string;
}): string {
    const parts: string[] = [];
    parts.push(
        opts.terms.length ? `<glossary>\n${formatGlossary(opts.terms, opts.chapter)}\n</glossary>` : "<glossary>\n(empty)\n</glossary>"
    );
    if (opts.totalChunks > 1) {
        parts.push(
            opts.chunk === 0
                ? `This is part 1 of ${opts.totalChunks} of the chapter. It starts with the chapter title.`
                : `This is part ${opts.chunk + 1} of ${opts.totalChunks} of the chapter, a continuation chunk: there is no title, omit the <title> block.`
        );
    }
    if (opts.previousContext) {
        parts.push(
            `<previous_translation>\n…${opts.previousContext}\n</previous_translation>\n(The end of the previous part, for continuity only. Do not repeat it.)`
        );
    }
    if (opts.feedback) {
        parts.push(`IMPORTANT: your previous attempt was rejected: ${opts.feedback}`);
    }
    parts.push(`<source>\n${opts.text}\n</source>`);
    return parts.join("\n\n");
}
