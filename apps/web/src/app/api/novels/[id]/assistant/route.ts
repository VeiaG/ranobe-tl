import { convertToModelMessages, hasToolCall, stepCountIs, streamText, tool, type InferUITools, type UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DB } from "@/db";
import { novel } from "@/db/schema";
import { ReadInput, SearchInput, readChapter, search } from "@/server/assistant";
import { ChatId, EditInput, SQL_TABLE, SqlInput, draftRows, editDraft, revertDraft, runSql } from "@/server/assistant-draft";
import { helperModel } from "@/server/service-model";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ShowInput = z.object({ summary: z.string().describe("For the user: what changed in the draft, with counts, and anything they should look at closely") });
const RevertInput = z.object({ chapters: z.array(z.number().int()).optional().describe("Chapters to put back as they were; all changed chapters when left out") });

function makeTools(database: DB, novelId: number, chatId: string) {
    return {
        search_translations: tool({
            description: "Searches the translated chapters of the draft, titles and text. Returns hits with context, every distinct matched form with its count, and the chapters.",
            inputSchema: SearchInput,
            execute: async (input) => search(await draftRows(database, novelId, chatId, input), "translation", input),
        }),
        search_sources: tool({
            description: "Searches the original (source) chapters, e.g. to learn which chapters mention a name and so must contain its translation.",
            inputSchema: SearchInput,
            execute: async (input) => search(await draftRows(database, novelId, chatId, input), "source", input),
        }),
        read_chapter: tool({
            description: "Reads part of a chapter's translation (as it is in the draft) or source.",
            inputSchema: ReadInput,
            execute: async (input) => readChapter((await draftRows(database, novelId, chatId, { only: input.chapter }))[0], input),
        }),
        sql: tool({
            description: `Runs one SQLite statement on the draft: SELECT to find chapters by any condition at once, UPDATE chapters SET title/text to change many chapters in one go. Table: ${SQL_TABLE}. A SELECT returns at most 300 rows, long values cut.`,
            inputSchema: SqlInput,
            execute: (input) => runSql(database, novelId, chatId, input),
        }),
        edit_chapters: tool({
            description: "Literal edits in the draft: each replaces every occurrence of `find` in one chapter's title or text. For changes that need a different word form in each sentence.",
            inputSchema: EditInput,
            execute: ({ edits }) => editDraft(database, novelId, chatId, edits),
        }),
        revert_chapters: tool({
            description: "Undoes your changes in the draft: puts chapters back as they were.",
            inputSchema: RevertInput,
            execute: ({ chapters }) => revertDraft(database, novelId, chatId, chapters),
        }),
        show_changes: tool({
            description: "Shows the user every change in the draft to review and apply. Call it when the task is done (or a large part of it), then stop: the user's answer comes as the next message.",
            inputSchema: ShowInput,
            execute: async ({ summary }) => ({ summary }),
        }),
    };
}

export type AssistantMessage = UIMessage<unknown, never, InferUITools<ReturnType<typeof makeTools>>>;

// Nothing here may change during a conversation: Anthropic binds thinking blocks to the system prompt.
const system = (n: { title: string; sourceLanguage: string; targetLanguage: string }) => `You help edit the ${n.targetLanguage} translation of the web novel "${n.title}" (translated from ${n.sourceLanguage}). The user asks for changes across chapters, most often to replace an old translation of a name or term with a new one.

You work on a draft: a copy of the novel's chapters made for this conversation. Every tool reads and changes the draft; the real chapters change only when the user reviews the draft and applies it.

How to work:
- Search before you change. A name appears in many grammatical forms (cases, number, adjective forms) and in older variants; search by stems with a regex (unicode mode, e.g. "Тяньлан\\p{L}*") and look at the "forms" of the result to see every spelling. search_sources tells which chapters mention the original name, so you can look for chapters where the translation went its own way.
- sql finds chapters by conditions a text search cannot express, all at once (titles still in ${n.sourceLanguage}: WHERE latin_share(title) > 0.5; a translated title left as the first line of the text), and changes many chapters with one UPDATE when the change is the same everywhere, e.g. UPDATE chapters SET title = first_line(text), text = rest_lines(text) WHERE …. Look with a SELECT before an UPDATE, and check the result after it.
- edit_chapters makes literal edits: "find" must be the exact current text (copy it from a search hit's "match" or from the chapter), "replace" is the new text in the right grammatical form for that sentence. Include neighbouring words in "find" when the form depends on them or when a bare word would hit unrelated places, and fix agreement of nearby words (adjectives, verbs, pronouns) if the new term has another gender or number. Edits that come back with an error changed nothing; fix them.
- Only change what the user asked for; leave everything else exactly as it is. A change that went wrong: revert_chapters, then do it again.
- Work through the whole task, then call show_changes once and stop. The user reviews the changes, applies or discards them chapter by chapter, and the next message tells you what happened. Applied chapters are saved; discarded ones are back as they were in the draft.
- Talk to the user in the language they write in. Be brief: say what you found (counts, forms) and what you changed.`;

/**
 * Earlier turns go back without their reasoning. Every request starts at a user message, so no tool
 * loop is open and the provider does not need them; signed thinking blocks would also be rejected
 * as soon as anything in the system prompt changed (the novel was renamed, for example).
 */
const withoutReasoning = (messages: AssistantMessage[]) => messages.map((m) => ({ ...m, parts: m.parts.filter((p) => p.type !== "reasoning") }));

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    // useChat shows a failed response's body as the error, so errors go out as plain text
    if (!(await getSession())) return new Response("Not signed in", { status: 401 });
    const novelId = Number((await params).id);
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n) return new Response("Novel not found", { status: 404 });
    const body = (await req.json()) as { id?: string; messages: AssistantMessage[] };
    const { messages } = body;
    const chatId = ChatId.safeParse(body.id);
    if (!chatId.success) return new Response("The chat has no valid id", { status: 400 });

    let model;
    try {
        model = await helperModel(db, "assistant", { id: n.id, title: n.title });
    } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
    }
    const tools = makeTools(db, novelId, chatId.data);
    const result = streamText({
        model: model.setup.model,
        system: system(n),
        messages: await convertToModelMessages(withoutReasoning(messages), { tools }),
        tools,
        providerOptions: model.setup.providerOptions,
        stopWhen: [stepCountIs(40), hasToolCall("show_changes")],
        abortSignal: req.signal,
        onStepFinish: async (step) => {
            await model.record(step.usage, true);
        },
    });
    return result.toUIMessageStreamResponse({
        onError: (error) => (error instanceof Error ? error.message : String(error)),
    });
}
