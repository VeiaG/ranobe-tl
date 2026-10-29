"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowUp, BookOpenText, Brain, Check, FileSearch, Loader2, MessagesSquare, PencilLine, Search, Square, X } from "lucide-react";
import { Streamdown } from "streamdown";
import type { AssistantMessage } from "@/app/api/novels/[id]/assistant/route";
import { EmptyState } from "@/components/page-header";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Message, MessageContent } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { cn, plural } from "@/lib/utils";
import { applyAssistantEdits } from "@/server/actions/assistant";
import type { ApplyResult, EditPreview } from "@/server/assistant";

type Part = AssistantMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/** A chat that searches the translations and proposes edits; it lives as long as the page is open. */
export function AssistantChat({ novelId, initialTask }: { novelId: number; initialTask?: string }) {
    const router = useRouter();
    const [text, setText] = useState(initialTask ?? "");
    const form = useRef<HTMLFormElement>(null);
    // decisions on propose_edits calls, by tool call id
    const [decided, setDecided] = useState<Record<string, ApplyResult | "rejected">>({});
    const { messages, sendMessage, status, stop, error } = useChat<AssistantMessage>({
        transport: new DefaultChatTransport({ api: `/api/novels/${novelId}/assistant` }),
    });
    const busy = status === "submitted" || status === "streaming";

    function send(e?: React.FormEvent) {
        e?.preventDefault();
        if (!text.trim() || busy) return;
        void sendMessage({ text: text.trim() });
        setText("");
    }

    function decide(id: string, result: ApplyResult | "rejected", message: string) {
        setDecided((d) => ({ ...d, [id]: result }));
        void sendMessage({ text: message });
        if (result !== "rejected" && result.applied.length) router.refresh();
    }

    const last = messages.at(-1);
    return (
        <div className="flex h-[calc(100dvh-22rem)] min-h-[28rem] flex-col gap-3">
            <MessageScrollerProvider autoScroll>
                <MessageScroller className="min-h-0 flex-1">
                    <MessageScrollerViewport>
                        <MessageScrollerContent className="gap-5 pb-4">
                            {messages.length === 0 && (
                                <EmptyState
                                    icon={MessagesSquare}
                                    title="Ask for a change across chapters"
                                    description="For example: “replace Тяньланьська магічна старша школа with Старша магічна школа Тяньлань in every form”. The assistant searches the translations and sources and proposes edits; nothing changes until you confirm them, and every changed chapter keeps its old text in the history."
                                />
                            )}
                            {messages.map((m) => (
                                <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === "user"}>
                                    {m.role === "user" ? (
                                        <Message align="end">
                                            <MessageContent>
                                                <Bubble align="end" variant="muted">
                                                    <BubbleContent className="whitespace-pre-wrap">{m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</BubbleContent>
                                                </Bubble>
                                            </MessageContent>
                                        </Message>
                                    ) : (
                                        <Message>
                                            <MessageContent className="gap-3">
                                                {m.parts.map((p, i) => (
                                                    <AssistantPart
                                                        key={i}
                                                        part={p}
                                                        novelId={novelId}
                                                        streaming={busy && m === last}
                                                        // a proposal is open while it is the newest thing in the chat
                                                        current={m === last && !busy}
                                                        decided={"toolCallId" in p ? decided[p.toolCallId] : undefined}
                                                        onDecide={decide}
                                                    />
                                                ))}
                                            </MessageContent>
                                        </Message>
                                    )}
                                </MessageScrollerItem>
                            ))}
                            {status === "submitted" && (
                                <TraceLine status="running">
                                    <TraceTitle>Thinking…</TraceTitle>
                                </TraceLine>
                            )}
                            {error && <p className="text-sm text-destructive">{error.message}</p>}
                        </MessageScrollerContent>
                    </MessageScrollerViewport>
                    <MessageScrollerButton />
                </MessageScroller>
            </MessageScrollerProvider>

            <form ref={form} onSubmit={send}>
                <InputGroup>
                    <InputGroupTextarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                form.current?.requestSubmit();
                            }
                        }}
                        placeholder="What should change in the translations?"
                        className="max-h-48 p-3"
                    />
                    <InputGroupAddon align="block-end">
                        <span className="text-xs text-muted-foreground">Enter sends, Shift+Enter adds a line</span>
                        {busy ? (
                            <InputGroupButton type="button" size="icon-sm" variant="outline" className="ml-auto rounded-full" aria-label="Stop" onClick={() => stop()}>
                                <Square />
                            </InputGroupButton>
                        ) : (
                            <InputGroupButton type="submit" size="icon-sm" variant="default" className="ml-auto rounded-full" aria-label="Send" disabled={!text.trim()}>
                                <ArrowUp />
                            </InputGroupButton>
                        )}
                    </InputGroupAddon>
                </InputGroup>
            </form>
        </div>
    );
}

function AssistantPart(props: {
    part: Part;
    novelId: number;
    streaming: boolean;
    current: boolean;
    decided: ApplyResult | "rejected" | undefined;
    onDecide: (id: string, result: ApplyResult | "rejected", message: string) => void;
}) {
    const { part: p } = props;
    if (p.type === "text") return p.text ? <Streamdown className="text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{p.text}</Streamdown> : null;
    if (p.type === "reasoning") {
        if (!p.text.trim()) return null;
        return (
            <TraceCollapsible>
                <TraceCollapsibleTrigger>
                    <TraceLine status={p.state === "streaming" ? "running" : undefined}>
                        <TraceIcon>
                            <Brain />
                        </TraceIcon>
                        <TraceTitle>{p.state === "streaming" ? "Thinking" : "Thought"}</TraceTitle>
                    </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                    <p className="text-xs whitespace-pre-wrap text-muted-foreground">{p.text}</p>
                </TraceCollapsibleContent>
            </TraceCollapsible>
        );
    }
    if (p.type === "tool-propose_edits") return <EditsCard {...props} part={p} />;
    if (p.type === "tool-search_translations" || p.type === "tool-search_sources" || p.type === "tool-read_chapter") return <ToolLine part={p} streaming={props.streaming} />;
    return null;
}

function ToolLine({ part: p, streaming }: { part: ToolPart; streaming: boolean }) {
    let icon = <Search />;
    let title = "";
    if (p.type === "tool-search_translations" || p.type === "tool-search_sources") {
        icon = p.type === "tool-search_sources" ? <FileSearch /> : <Search />;
        title = `${p.type === "tool-search_sources" ? "Searched the sources" : "Searched the translations"} for “${p.input?.query ?? "…"}”`;
    } else if (p.type === "tool-read_chapter") {
        icon = <BookOpenText />;
        title = `Read chapter ${p.input?.chapter ?? "…"}${p.input?.part === "source" ? " (source)" : ""}`;
    }

    if (p.state === "output-error") {
        return (
            <Trace>
                <TraceLine status="error">
                    <TraceIcon>{icon}</TraceIcon>
                    <TraceTitle>
                        {title}: {p.errorText}
                    </TraceTitle>
                </TraceLine>
            </Trace>
        );
    }
    if (p.state !== "output-available") {
        return (
            <Trace>
                <TraceLine status={streaming ? "running" : "error"}>
                    <TraceIcon>{icon}</TraceIcon>
                    <TraceTitle>{streaming ? title : `${title}: stopped`}</TraceTitle>
                </TraceLine>
            </Trace>
        );
    }

    if (p.type === "tool-read_chapter") {
        return (
            <Trace>
                <TraceLine>
                    <TraceIcon>{icon}</TraceIcon>
                    <TraceTitle>{title}</TraceTitle>
                </TraceLine>
            </Trace>
        );
    }
    if (p.type !== "tool-search_translations" && p.type !== "tool-search_sources") return null;
    const out = p.output;
    return (
        <Trace>
            <TraceCollapsible>
                <TraceCollapsibleTrigger>
                    <TraceLine>
                        <TraceIcon>{icon}</TraceIcon>
                        <TraceTitle>
                            {title}: {out.totalMatches ? `${plural(out.totalMatches, "match", "matches")} in ${plural(out.chapters.length, "chapter")}` : "nothing"}
                        </TraceTitle>
                    </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                    <div className="grid gap-2 text-xs">
                        {Object.keys(out.forms).length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {Object.entries(out.forms).map(([form, n]) => (
                                    <span key={form} className="rounded-md bg-muted px-1.5 py-0.5">
                                        {form} <span className="text-muted-foreground tabular-nums">{n}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                        <ul className="grid max-h-56 gap-1 overflow-y-auto">
                            {out.hits.map((h, i) => (
                                <li key={i} className="text-muted-foreground">
                                    <span className="tabular-nums">{h.chapter}</span>
                                    {h.in === "title" && " (title)"}: {h.snippet}
                                </li>
                            ))}
                        </ul>
                    </div>
                </TraceCollapsibleContent>
            </TraceCollapsible>
        </Trace>
    );
}

/** The edits of one propose_edits call: pick, apply, and tell the assistant what happened. */
function EditsCard(props: {
    part: Extract<Part, { type: "tool-propose_edits" }>;
    novelId: number;
    current: boolean;
    streaming: boolean;
    decided: ApplyResult | "rejected" | undefined;
    onDecide: (id: string, result: ApplyResult | "rejected", message: string) => void;
}) {
    const { part: p, decided } = props;
    const edits: EditPreview[] = p.state === "output-available" ? p.output.edits : [];
    const valid = edits.map((e, i) => [e, i] as const).filter(([e]) => !e.error);
    const [chosen, setChosen] = useState<Set<number> | null>(null);
    const selected = chosen ?? new Set(valid.map(([, i]) => i));
    const [pending, start] = useTransition();

    if (p.state === "output-error") return <p className="text-sm text-destructive">The proposal failed: {p.errorText}</p>;
    if (p.state !== "output-available") {
        return (
            <TraceLine status={props.streaming ? "running" : "error"}>
                <TraceIcon>
                    <PencilLine />
                </TraceIcon>
                <TraceTitle>{props.streaming ? "Preparing edits" : "The proposal was cut off"}</TraceTitle>
            </TraceLine>
        );
    }

    const open = !decided && props.current;
    const toggle = (i: number, on: boolean) =>
        setChosen(() => {
            const next = new Set(selected);
            if (on) next.add(i);
            else next.delete(i);
            return next;
        });

    function apply() {
        const picked = [...selected].sort((a, b) => a - b).map((i) => edits[i]);
        start(async () => {
            const res = await applyAssistantEdits(
                props.novelId,
                picked.map(({ chapter, field, find, replace }) => ({ chapter, field, find, replace }))
            );
            if (!res.ok) return void toast.error(res.error);
            const r = res.data!;
            const skipped = edits.filter((_, i) => !selected.has(i) && !edits[i].error);
            const lines = [
                `Applied ${r.applied.length} of ${edits.length} proposed edits (${r.applied.reduce((a, x) => a + x.occurrences, 0)} replacements in ${new Set(r.applied.map((x) => x.chapter)).size} chapters).`,
                ...skipped.map((e) => `Rejected by me: chapter ${e.chapter} ${e.field} “${e.find}” → “${e.replace}”`),
                ...r.failed.map((f) => `Failed: chapter ${f.chapter} ${f.field} “${f.find}”: ${f.reason}`),
            ];
            props.onDecide(p.toolCallId, r, lines.join("\n"));
            toast.success(`${plural(r.applied.length, "edit")} applied`);
        });
    }

    return (
        <div className="grid gap-3 rounded-xl border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <PencilLine className="size-4 text-brand" />
                    {p.output.summary}
                </div>
                <span className="text-xs text-muted-foreground">
                    {plural(edits.length, "edit")} in {plural(new Set(edits.map((e) => e.chapter)).size, "chapter")}
                </span>
            </div>
            <ul className="grid max-h-[28rem] gap-1.5 overflow-y-auto">
                {edits.map((e, i) => (
                    <li key={i} className={cn("grid gap-1 rounded-lg border px-3 py-2 text-xs", e.error && "opacity-70")}>
                        <label className="flex items-center gap-2">
                            <Checkbox disabled={!open || !!e.error} checked={!e.error && selected.has(i)} onCheckedChange={(v) => toggle(i, v === true)} />
                            <span className="font-medium tabular-nums">Chapter {e.chapter}</span>
                            {e.field === "title" && <span className="text-muted-foreground">title</span>}
                            {e.occurrences > 1 && <span className="text-muted-foreground">×{e.occurrences}</span>}
                        </label>
                        {e.error ? (
                            <p className="text-destructive">
                                “{e.find}”: {e.error}
                            </p>
                        ) : (
                            <>
                                <p className="break-words text-destructive/90">{e.before}</p>
                                <p className="break-words text-success">{e.after}</p>
                            </>
                        )}
                    </li>
                ))}
            </ul>
            {open ? (
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={apply} disabled={pending || selected.size === 0}>
                        {pending ? <Loader2 className="animate-spin" /> : <Check />}
                        Apply {plural(selected.size, "edit")}
                    </Button>
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => props.onDecide(p.toolCallId, "rejected", "I rejected all these edits.")}>
                        <X />
                        Reject all
                    </Button>
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">
                    {decided === "rejected"
                        ? "Rejected."
                        : decided
                          ? `Applied ${plural(decided.applied.length, "edit")}${decided.failed.length ? `, ${decided.failed.length} failed` : ""}.`
                          : "Not applied."}
                </p>
            )}
        </div>
    );
}
