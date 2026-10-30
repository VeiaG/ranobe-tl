import type { TranslationConfig as Config } from "../config";

/** "Ukrainian", "українська", "uk" in any case. */
export function isUkrainian(language: string): boolean {
    return /^(ukrainian|українська|uk)$/i.test(language.trim());
}

/**
 * Rules of the target language that hold for every novel, appended to the system prompts.
 * Ukrainian only for now. `dialogue`: the prompt writes prose (translation), not a glossary (extraction).
 */
export function languageRules(config: Pick<Config, "sourceLanguage" | "targetLanguage">, opts: { dialogue: boolean }): string {
    if (!isUkrainian(config.targetLanguage)) return "";
    const rules = [
        opts.dialogue &&
            "Format direct speech the Ukrainian way: each speaker's line starts a new paragraph with an em dash (—), without quotation marks. Author's words after a line go after « — » in the same paragraph.",
        `Names and terms: transliterate only names that have no meaning in ${config.sourceLanguage}, such as Chinese, Korean or Japanese personal names (romanized → standard Ukrainian transcription). Everything the source writes as meaningful ${config.sourceLanguage} words is translated by meaning, not transliterated: titles, nicknames, account and character names, teams, clubs, guilds, sects, places, classes, skills, techniques and items. Keep only established loanwords as they are (ніндзя, сюрікен).`,
    ].filter(Boolean);
    return `\n\n## Ukrainian\n${rules.map((r) => `- ${r}`).join("\n")}`;
}
