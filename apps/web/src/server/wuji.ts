import "server-only";
import { createHeadlessEditor } from "@lexical/headless";
import { ListItemNode, ListNode } from "@lexical/list";
import {
    $convertFromMarkdownString,
    BOLD_ITALIC_STAR,
    BOLD_ITALIC_UNDERSCORE,
    BOLD_STAR,
    BOLD_UNDERSCORE,
    HEADING,
    INLINE_CODE,
    ITALIC_STAR,
    ITALIC_UNDERSCORE,
    ORDERED_LIST,
    QUOTE,
    STRIKETHROUGH,
    UNORDERED_LIST,
} from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";

// wuji.world is a Payload CMS site; chapters go into its bookChapters collection through the REST API.
export const WUJI_API = (process.env.WUJI_API_URL ?? "https://wuji.world/api").replace(/\/$/, "");

// Only what the site's editor supports (Payload's default features). Links are left out:
// Payload's link node has its own JSON shape, and code blocks are not enabled on the site.
const TRANSFORMERS = [
    HEADING,
    QUOTE,
    UNORDERED_LIST,
    ORDERED_LIST,
    INLINE_CODE,
    BOLD_ITALIC_STAR,
    BOLD_ITALIC_UNDERSCORE,
    BOLD_STAR,
    BOLD_UNDERSCORE,
    ITALIC_STAR,
    ITALIC_UNDERSCORE,
    STRIKETHROUGH,
];

const editor = createHeadlessEditor({
    namespace: "wuji",
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
    onError: (error) => {
        throw error;
    },
});

/** A translated chapter (markdown) as the Lexical state of a Payload rich text field. */
export function markdownToLexical(markdown: string) {
    editor.update(() => $convertFromMarkdownString(markdown, TRANSFORMERS), { discrete: true });
    return editor.getEditorState().toJSON();
}

export async function wujiFetch<T = any>(path: string, init: { token?: string; method?: string; body?: unknown; signal?: AbortSignal } = {}, attempt = 1): Promise<T> {
    const res = await fetch(`${WUJI_API}${path}`, {
        method: init.method ?? "GET",
        headers: {
            ...(init.token ? { Authorization: `JWT ${init.token}` } : {}),
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
    });
    if (res.ok) return res.json();
    // rate limits and server hiccups: wait and try again a few times
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        return wujiFetch(path, init, attempt + 1);
    }
    const text = await res.text();
    let message = text.slice(0, 300);
    try {
        const data = JSON.parse(text);
        message = data.errors?.map((e: { message: string; data?: { errors?: { message: string }[] } }) => [e.message, ...(e.data?.errors?.map((x) => x.message) ?? [])].join(": ")).join("; ") || message;
    } catch {}
    throw new Error(`wuji.world: ${res.status} ${message}`);
}

export interface WujiUser {
    id: string;
    email: string;
    nickname: string | null;
    roles: string[];
    bookAccess: string[];
}

/** Accepts a pasted `payload-token=…` cookie pair as well as the bare value. */
export const cleanToken = (token: string) => token.trim().replace(/^payload-token=/, "").replace(/;.*$/, "");

export async function wujiLogin(email: string, password: string): Promise<string> {
    const { token } = await wujiFetch<{ token?: string }>("/users/login", { method: "POST", body: { email, password } });
    if (!token) throw new Error("wuji.world did not return a token");
    return token;
}

export async function wujiMe(token: string): Promise<WujiUser> {
    const { user } = await wujiFetch<{ user: any }>("/users/me?depth=0", { token });
    if (!user) throw new Error("wuji.world did not accept the token: it expired or is wrong");
    return {
        id: user.id,
        email: user.email,
        nickname: user.nickname ?? null,
        roles: user.roles ?? [],
        bookAccess: (user.bookAccess ?? []).map((b: string | { id: string }) => (typeof b === "string" ? b : b.id)),
    };
}

export interface WujiBook {
    id: string;
    title: string;
    slug: string;
    chapterCount: number;
    cover: string | null;
}

const absolute = (url: string | null | undefined) => (!url ? null : url.startsWith("/") ? new URL(WUJI_API).origin + url : url);

/** Books this account can add chapters to (the site's own rules: admins any, editors theirs by access, writers their own). */
export async function wujiBooks(token: string, q: string): Promise<WujiBook[]> {
    const user = await wujiMe(token);
    const params = new URLSearchParams({ limit: "20", depth: "1", sort: "title" });
    for (const f of ["title", "slug", "chapterCount", "coverImage"]) params.set(`select[${f}]`, "true");
    let and = 0;
    if (q.trim()) params.set(`where[and][${and++}][title][like]`, q.trim());
    if (!user.roles.includes("admin")) {
        const or: [string, string][] = [];
        if (user.roles.includes("editor") && user.bookAccess.length) or.push(["id][in", user.bookAccess.join(",")]);
        if (user.roles.includes("writer")) or.push(["owner][equals", user.id]);
        if (!or.length) return [];
        or.forEach(([field, value], i) => params.set(`where[and][${and}][or][${i}][${field}]`, value));
    }
    const { docs } = await wujiFetch<{ docs: any[] }>(`/books?${params}`, { token });
    return docs.map((b) => ({
        id: b.id,
        title: b.title,
        slug: b.slug,
        chapterCount: b.chapterCount ?? 0,
        cover: absolute(typeof b.coverImage === "object" ? (b.coverImage?.sizes?.thumbnail?.url ?? b.coverImage?.url) : null),
    }));
}
