import type { AskNewPolicy } from "@ranobe-tl/core";
import {
    bigserial,
    boolean,
    doublePrecision,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    serial,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
    timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date());

// ---------- auth (Better Auth) ----------

export const user = pgTable("user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    /** "admin" manages users, invites and API keys; the first user becomes admin. */
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
});

export const session = pgTable("session", {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
});

export const account = pgTable("account", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
});

export const verification = pgTable("verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
});

export const invite = pgTable("invite", {
    token: text("token").primaryKey(),
    note: text("note").notNull().default(""),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    usedBy: text("used_by").references(() => user.id, { onDelete: "set null" }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
});

export const telegramLink = pgTable("telegram_link", {
    userId: text("user_id")
        .primaryKey()
        .references(() => user.id, { onDelete: "cascade" }),
    /** One-time token for /start; cleared once the chat is linked. */
    linkToken: text("link_token").unique(),
    chatId: text("chat_id"),
    username: text("username"),
    notifyDecisions: boolean("notify_decisions").notNull().default(true),
    notifyFailures: boolean("notify_failures").notNull().default(true),
    notifyFinished: boolean("notify_finished").notNull().default(true),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    createdAt: createdAt(),
});

// ---------- providers ----------

export const providerKey = pgTable("provider_key", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    baseURL: text("base_url"),
    /** AES-256-GCM, see lib/crypto. */
    encryptedKey: text("encrypted_key").notNull(),
    /** Last characters of the key, to tell keys apart in the UI. */
    hint: text("hint").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
});

// ---------- novels ----------

export const NOVEL_STATUSES = ["idle", "running", "waiting", "paused", "error"] as const;
export type NovelStatus = (typeof NOVEL_STATUSES)[number];

/**
 * How the run handles proposed changes to existing terms:
 * - queue: keep translating with the current glossary, decide later
 * - pause: stop the novel until every proposal of the chunk is decided, then translate the chapter again
 */
export const DECISION_MODES = ["queue", "pause"] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

export const novel = pgTable("novel", {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    originalTitle: text("original_title").notNull().default(""),
    synopsis: text("synopsis").notNull().default(""),
    sourceLanguage: text("source_language").notNull().default("English"),
    targetLanguage: text("target_language").notNull().default("Ukrainian"),
    providerKeyId: integer("provider_key_id").references(() => providerKey.id, { onDelete: "set null" }),
    model: text("model").notNull().default(""),
    /** The rest of TranslationConfig (effort, chunking, validation, instructions, ...). */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    decisionMode: text("decision_mode").$type<DecisionMode>().notNull().default("queue"),
    /** Opt-in review of new terms; null = new terms are added without asking. */
    askNew: jsonb("ask_new").$type<AskNewPolicy | null>(),
    status: text("status").$type<NovelStatus>().notNull().default("idle"),
    statusMessage: text("status_message").notNull().default(""),
    /** Set by the user to abort the chapter in flight. */
    stopRequested: boolean("stop_requested").notNull().default(false),
    /** Chapters failed in a row; the run pauses itself after a few (bad key, dead endpoint). */
    failStreak: integer("fail_streak").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
});

export const CHAPTER_STATUSES = ["new", "queued", "translating", "done", "failed", "skipped"] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export const chapter = pgTable(
    "chapter",
    {
        id: serial("id").primaryKey(),
        novelId: integer("novel_id")
            .notNull()
            .references(() => novel.id, { onDelete: "cascade" }),
        index: integer("idx").notNull(),
        sourceTitle: text("source_title").notNull().default(""),
        source: text("source").notNull(),
        status: text("status").$type<ChapterStatus>().notNull().default("new"),
        title: text("title"),
        content: text("content"),
        attempts: integer("attempts").notNull().default(0),
        ratio: doublePrecision("ratio"),
        error: text("error").notNull().default(""),
        model: text("model").notNull().default(""),
        inputTokens: integer("input_tokens").notNull().default(0),
        cachedTokens: integer("cached_tokens").notNull().default(0),
        outputTokens: integer("output_tokens").notNull().default(0),
        /** Seconds spent on the last translation. */
        duration: integer("duration"),
        translatedAt: timestamp("translated_at", { withTimezone: true }),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
    },
    (t) => [uniqueIndex("chapter_novel_idx").on(t.novelId, t.index), index("chapter_novel_status").on(t.novelId, t.status)]
);

// ---------- glossary ----------

export const term = pgTable(
    "term",
    {
        id: serial("id").primaryKey(),
        novelId: integer("novel_id")
            .notNull()
            .references(() => novel.id, { onDelete: "cascade" }),
        source: text("source").notNull(),
        sourceNorm: text("source_norm").notNull(),
        target: text("target").notNull(),
        type: text("type").notNull().default("other"),
        note: text("note").notNull().default(""),
        locked: boolean("locked").notNull().default(false),
        firstChapter: integer("first_chapter"),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
    },
    (t) => [uniqueIndex("term_novel_norm").on(t.novelId, t.sourceNorm)]
);

export const termGender = pgTable(
    "term_gender",
    {
        termId: integer("term_id")
            .notNull()
            .references(() => term.id, { onDelete: "cascade" }),
        fromChapter: integer("from_chapter").notNull(),
        gender: text("gender").notNull(),
    },
    (t) => [primaryKey({ columns: [t.termId, t.fromChapter] })]
);

export const termChange = pgTable(
    "term_change",
    {
        id: serial("id").primaryKey(),
        novelId: integer("novel_id")
            .notNull()
            .references(() => novel.id, { onDelete: "cascade" }),
        termId: integer("term_id")
            .notNull()
            .references(() => term.id, { onDelete: "cascade" }),
        field: text("field").notNull(),
        oldValue: text("old_value").notNull(),
        newValue: text("new_value").notNull(),
        chapter: integer("chapter"),
        evidence: text("evidence").notNull().default(""),
        reason: text("reason").notNull().default(""),
        status: text("status").notNull(),
        decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
        decidedAt: timestamp("decided_at", { withTimezone: true }),
        createdAt: createdAt(),
    },
    (t) => [index("term_change_novel_status").on(t.novelId, t.status), index("term_change_term").on(t.termId)]
);

/** Sources the user marked as "not a term": the model's proposals for them are dropped. */
export const ignoredTerm = pgTable(
    "ignored_term",
    {
        novelId: integer("novel_id")
            .notNull()
            .references(() => novel.id, { onDelete: "cascade" }),
        sourceNorm: text("source_norm").notNull(),
        source: text("source").notNull(),
        createdAt: createdAt(),
    },
    (t) => [primaryKey({ columns: [t.novelId, t.sourceNorm] })]
);

// ---------- activity ----------

export const event = pgTable(
    "event",
    {
        id: bigserial("id", { mode: "number" }).primaryKey(),
        novelId: integer("novel_id")
            .notNull()
            .references(() => novel.id, { onDelete: "cascade" }),
        chapter: integer("chapter"),
        level: text("level").$type<"info" | "success" | "warning" | "error">().notNull().default("info"),
        message: text("message").notNull(),
        createdAt: createdAt(),
    },
    (t) => [index("event_novel_id").on(t.novelId, t.id)]
);

/** Raw prompts and outputs, kept for the last attempts of each chapter (debugging). */
export const exchange = pgTable(
    "exchange",
    {
        id: bigserial("id", { mode: "number" }).primaryKey(),
        novelId: integer("novel_id")
            .notNull()
            .references(() => novel.id, { onDelete: "cascade" }),
        chapter: integer("chapter").notNull(),
        chunk: integer("chunk").notNull(),
        attempt: integer("attempt").notNull(),
        prompt: text("prompt").notNull(),
        output: text("output").notNull(),
        createdAt: createdAt(),
    },
    (t) => [index("exchange_novel_chapter").on(t.novelId, t.chapter)]
);
