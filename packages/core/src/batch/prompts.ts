import type { TranslationConfig as Config } from "../config";
import { TERM_TYPES, type Term } from "../glossary/store";
import { languageRules } from "../pipeline/language";
import { formatGlossary } from "../pipeline/prompt";

function about(config: Config): string {
    const lines = [config.novel.title && `Novel: ${config.novel.title}`, config.novel.synopsis && `Synopsis: ${config.novel.synopsis}`].filter(Boolean);
    return lines.length ? `\n${lines.join("\n")}\n` : "";
}

/**
 * Term extraction, one chapter per request. Static per novel, so the provider can cache it.
 * The model reads the chapter and lists the terms with a proposed translation; nothing is translated.
 */
export function extractSystemPrompt(config: Config): string {
    const { sourceLanguage: from, targetLanguage: to } = config;
    return `You build the glossary for a ${from} → ${to} translation of a web novel.
${about(config)}
Read the chapter inside <source> and list every term that later chapters must translate the same way:
- proper names: people, places, sects, clans, organizations, countries;
- titles and ranks, cultivation realms, techniques and skills, treasures and items, unique creatures, coined terms.
Do NOT list common words or phrases with an obvious translation ("father", "sword", "fourth uncle", "the young man").

<glossary> lists terms already decided for this novel that occur in the chapter. Do not list them again unless the chapter clearly shows the entry is wrong (another gender, another meaning).

## Answer
Reply with a JSON array only, no commentary, no code fences. Each item:
{"source": "the term exactly as written in ${from}", "target": "${to} translation", "type": one of ${TERM_TYPES.map((t) => `"${t}"`).join(", ")}, "gender": "m" | "f" | "unknown", "note": "a few words: who or what it is", "evidence": "a short exact quote from <source> where it appears"}

Rules:
- "target": the dictionary form (nominative case), capitalized only if ${from} capitalizes the term. Transliterate names consistently.
- "gender" only for type "person": "m" or "f" when the text makes it clear (pronouns, titles, forms of address), otherwise "unknown".
- Titles and ranks ("Saintess", "Elder", "Patriarch", "Young Master") are type "rank", never "person", and have no gender: give the neutral or masculine base form; the translator puts it in the holder's gender. A title used for a woman is not a reason to give it a feminine "target".
- "evidence" is copied character for character from <source>, at most one sentence.
- An empty chapter or a chapter without terms: [].${languageRules(config, { dialogue: false })}${config.instructions ? `\n\n## Notes from the user about this novel\n${config.instructions}` : ""}`;
}

export function extractUserPrompt(opts: { text: string; terms: Term[]; chapter: number }): string {
    const glossary = opts.terms.length ? formatGlossary(opts.terms, opts.chapter) : "(empty)";
    return `<glossary>\n${glossary}\n</glossary>\n\n<source>\n${opts.text}\n</source>`;
}

/**
 * Translation with a glossary decided beforehand: the model only translates, it proposes nothing.
 * Chunks of a chapter are translated in parallel, so the context is the source before the chunk.
 */
export function batchSystemPrompt(config: Config): string {
    const { sourceLanguage: from, targetLanguage: to } = config;
    return `You are a professional literary translator of web novels from ${from} to ${to}.
${about(config)}
Translate the text inside <source> completely and faithfully: every paragraph, every line of dialogue, nothing summarized, nothing added. Keep the paragraph structure. Write natural, fluent ${to} prose that keeps the tone of the original.

## Glossary
The user message contains the glossary of terms found in this text, formatted as:
  source → translation [type, gender, note]
These translations are final. Use them consistently, declined/conjugated as ${to} grammar requires. An entry stands for the meaning its type and note describe: when the source uses the same word in another, ordinary sense, translate that occurrence naturally. The bracketed part is reference information only: never copy it into the translation. Gender tells you which grammatical gender to use for that character (m = male, f = female).
Titles and ranks (type "rank") are given in their base form: put them in the gender of the person who holds them (e.g. a female holder of a title gets the feminine form), and decline them as usual.
Letter case is not part of a glossary entry: follow the source at each occurrence.

## Output format
Respond with exactly these blocks and nothing outside them:

<title>translated chapter title (one line: the first line of the source)</title>
<translation>
the full translated text, without the title
</translation>

Omit <title> when the user message says the text is a continuation chunk.
No markdown, no code fences, no commentary.${languageRules(config, { dialogue: true })}${config.instructions ? `\n\n## Additional instructions\n${config.instructions}` : ""}`;
}

export function batchUserPrompt(opts: {
    text: string;
    terms: Term[];
    chapter: number;
    chunk: number;
    totalChunks: number;
    /** The end of the source before this chunk. */
    sourceContext?: string;
    feedback?: string;
}): string {
    const parts: string[] = [];
    parts.push(opts.terms.length ? `<glossary>\n${formatGlossary(opts.terms, opts.chapter)}\n</glossary>` : "<glossary>\n(empty)\n</glossary>");
    if (opts.totalChunks > 1) {
        parts.push(
            opts.chunk === 0
                ? `This is part 1 of ${opts.totalChunks} of the chapter. It starts with the chapter title.`
                : `This is part ${opts.chunk + 1} of ${opts.totalChunks} of the chapter, a continuation chunk: there is no title, omit the <title> block.`
        );
    }
    if (opts.sourceContext) {
        parts.push(`<previous_source>\n…${opts.sourceContext}\n</previous_source>\n(The source text just before this part, for context only. Do not translate it.)`);
    }
    if (opts.feedback) parts.push(`IMPORTANT: your previous attempt was rejected: ${opts.feedback}`);
    parts.push(`<source>\n${opts.text}\n</source>`);
    return parts.join("\n\n");
}
