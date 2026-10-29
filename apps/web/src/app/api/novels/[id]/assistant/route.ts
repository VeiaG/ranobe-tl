import { convertToModelMessages, hasToolCall, stepCountIs, streamText, tool, type InferUITools, type UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { db, type DB } from "@/db";
import { novel } from "@/db/schema";
import { ProposeInput, ReadInput, SearchInput, previewEdits, readChapter, search } from "@/server/assistant";
import { helperModel } from "@/server/service-model";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function makeTools(database: DB, novelId: number) {
    return {
        search_translations: tool({
            description: "Searches the translated chapters, titles and text. Returns hits with context, every distinct matched form with its count, and the chapters.",
            inputSchema: SearchInput,
            execute: (input) => search(database, novelId, "translation", input),
        }),
        search_sources: tool({
            description: "Searches the original (source) chapters, e.g. to learn which chapters mention a name and so must contain its translation.",
            inputSchema: SearchInput,
            execute: (input) => search(database, novelId, "source", input),
        }),
        read_chapter: tool({
            description: "Reads part of a chapter's translation or source.",
            inputSchema: ReadInput,
            execute: (input) => readChapter(database, novelId, input),
        }),
        propose_edits: tool({
            description:
                "Proposes literal edits for the user to confirm. Each replaces every occurrence of `find` in one chapter's title or text. Nothing is written until the user confirms; their answer comes as the next message.",
            inputSchema: ProposeInput,
            execute: async ({ summary, edits }) => ({ summary, edits: await previewEdits(database, novelId, edits) }),
        }),
    };
}

export type AssistantMessage = UIMessage<unknown, never, InferUITools<ReturnType<typeof makeTools>>>;

// Nothing here may change during a conversation: Anthropic binds thinking blocks to the system prompt.
const system = (n: { title: string; sourceLanguage: string; targetLanguage: string }) => `You help edit the ${n.targetLanguage} translation of the web novel "${n.title}" (translated from ${n.sourceLanguage}). The user asks for changes across chapters, most often to replace an old translation of a name or term with a new one.

How to work:
- Search before you propose. A name appears in many grammatical forms (cases, number, adjective forms) and in older variants; search by stems with a regex (unicode mode, e.g. "Тяньлан\\p{L}*") and look at the "forms" of the result to see every spelling. search_sources tells which chapters mention the original name, so you can look for chapters where the translation went its own way.
- Edits are literal: "find" must be the exact current text (copy it from a search hit's "match" or from the chapter), "replace" is the new text in the right grammatical form for that sentence. Include neighbouring words in "find" when the form depends on them or when a bare word would hit unrelated places, and fix agreement of nearby words (adjectives, verbs, pronouns) if the new term has another gender or number.
- Only change what the user asked for; leave everything else exactly as it is.
- Propose in batches of at most 100 edits, grouped sensibly. After calling propose_edits stop and wait: the user confirms or rejects each edit, and the next message tells you what was applied. Then continue with the next batch, or say you are done.
- Edits that come back with an error were not valid; fix them in the next batch.
- Talk to the user in the language they write in. Be brief: say what you found (counts, forms) and what you propose.`;

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
    const { messages } = (await req.json()) as { messages: AssistantMessage[] };

    let model;
    try {
        model = await helperModel(db, "assistant", { id: n.id, title: n.title });
    } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
    }
    const tools = makeTools(db, novelId);
    const result = streamText({
        model: model.setup.model,
        system: system(n),
        messages: await convertToModelMessages(withoutReasoning(messages), { tools }),
        tools,
        providerOptions: model.setup.providerOptions,
        stopWhen: [stepCountIs(40), hasToolCall("propose_edits")],
        abortSignal: req.signal,
        onStepFinish: async (step) => {
            await model.record(step.usage, true);
        },
    });
    return result.toUIMessageStreamResponse({
        onError: (error) => (error instanceof Error ? error.message : String(error)),
    });
}
