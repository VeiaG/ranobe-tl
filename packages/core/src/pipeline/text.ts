const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Replaces lone UTF-16 surrogates with U+FFFD. A cut in the middle of an emoji (a context slice, an excerpt)
 * or a broken scraped source leaves one, and the API rejects the whole request as invalid JSON.
 */
export function wellFormed(text: string): string {
    return text.replace(LONE_SURROGATE, "�");
}
