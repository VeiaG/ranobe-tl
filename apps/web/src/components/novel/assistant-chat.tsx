"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowUp, BookOpenText, Brain, Check, Database, FileDiff, FileSearch, Loader2, MessagesSquare, PencilLine, Search, Square, Undo2, X } from "lucide-react";
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
import { applyDraftChanges, discardDraftChanges, getDraftChanges } from "@/server/actions/assistant";
import type { DraftChange } from "@/server/assistant-draft";
import type { Segment } from "@/lib/diff";

type Part = AssistantMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/** A chat that changes a draft of the chapters and shows the changes to apply; it lives as long as the page is open. */
export function AssistantChat({ novelId, initialTask }: { novelId: number; initialTask?: string }) {
    const router = useRouter();
    const [text, setText] = useState(initialTask ?? "");
    const form = useRef<HTMLFormElement>(null);
    const { id: chatId, messages, sendMessage, status, stop, error } = useChat<AssistantMessage>({
        transport: new DefaultChatTransport({ api: `/api/novels/${novelId}/assistant` }),
    });
    const busy = status === "submitted" || status === "streaming";
    const [review, setReview] = useState(false);
    // what the user did with the draft since their last message; the assistant learns it with the next one
    const [notes, setNotes] = useState<string[]>([]);

    function send(e?: React.FormEvent) {
        e?.preventDefault();
        if (!text.trim() || busy) return;
        void sendMessage({ text: notes.length ? `${notes.join("\n")}\n\n${text.trim()}` : text.trim() });
        setNotes([]);
        setText("");
    }

    const reviewed = (note: string, applied: boolean) => {
        setNotes((n) => [...n, note]);
        if (applied) router.refresh();
    };

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
                                    description="For example: “replace Тяньланьська магічна старша школа with Старша магічна школа Тяньлань in every form”. The assistant works on a draft of the chapters: it searches, queries with SQL and edits the draft, then shows you the changes. Nothing changes until you apply them, and every applied chapter keeps its old text in the history."
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
                                                        onReview={() => setReview(true)}
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

            {review && !busy && <DraftReview novelId={novelId} chatId={chatId} onClose={() => setReview(false)} onDone={reviewed} />}
            {notes.length > 0 && <p className="text-xs text-muted-foreground">{notes.join(" ")} The assistant learns it with your next message.</p>}

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
                        {messages.length > 0 && !review && (
                            <InputGroupButton type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setReview(true)}>
                                <FileDiff />
                                Review the draft
                            </InputGroupButton>
                        )}
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

function AssistantPart(props: { part: Part; novelId: number; streaming: boolean; onReview: () => void }) {
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
    if (p.type === "tool-show_changes") {
        if (p.state !== "output-available") return null;
        return (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
                <div className="flex items-center gap-2 text-sm">
                    <FileDiff className="size-4 shrink-0 text-brand" />
                    {p.output.summary}
                </div>
                <Button size="sm" onClick={props.onReview}>
                    Review the changes
                </Button>
            </div>
        );
    }
    if ("toolCallId" in p) return <ToolLine part={p} streaming={props.streaming} />;
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
    } else if (p.type === "tool-sql") {
        icon = <Database />;
        title = /^\s*update\b/i.test(p.input?.sql ?? "") ? "Changed the draft with SQL" : "Queried the chapters";
    } else if (p.type === "tool-edit_chapters") {
        icon = <PencilLine />;
        title = `Edited the draft (${plural(p.input?.edits?.length ?? 0, "edit")})`;
    } else if (p.type === "tool-revert_chapters") {
        icon = <Undo2 />;
        title = p.input?.chapters ? `Reverted ${plural(p.input.chapters.length, "chapter")} in the draft` : "Reverted the draft";
    } else return null;

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

    if (p.type === "tool-sql") {
        const out = p.output;
        const summary = "error" in out ? out.error : "rows" in out ? `${plural(out.totalRows, "row")}` : `${plural(out.updated, "chapter")} updated`;
        return (
            <Trace>
                <TraceCollapsible>
                    <TraceCollapsibleTrigger>
                        <TraceLine status={"error" in out ? "error" : undefined}>
                            <TraceIcon>{icon}</TraceIcon>
                            <TraceTitle>
                                {title}: {summary}
                            </TraceTitle>
                        </TraceLine>
                    </TraceCollapsibleTrigger>
                    <TraceCollapsibleContent>
                        <pre className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{p.input.sql}</pre>
                    </TraceCollapsibleContent>
                </TraceCollapsible>
            </Trace>
        );
    }
    if (p.type === "tool-edit_chapters") {
        const failed = p.output.results.filter((r) => r.error).length;
        return (
            <Trace>
                <TraceLine status={failed ? "error" : undefined}>
                    <TraceIcon>{icon}</TraceIcon>
                    <TraceTitle>
                        {title}
                        {failed ? `, ${failed} failed` : ""}
                    </TraceTitle>
                </TraceLine>
            </Trace>
        );
    }
    if (p.type === "tool-read_chapter" || p.type === "tool-revert_chapters") {
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

function Segments({ segments }: { segments: Segment[] }) {
    return (
        <>
            {segments.map((s, i) =>
                s.kind === "same" ? (
                    <span key={i}>{s.text}</span>
                ) : (
                    <span key={i} className={cn("rounded-sm", s.kind === "del" ? "bg-destructive/15 text-destructive line-through" : "bg-success/15 text-success")}>
                        {s.text}
                    </span>
                )
            )}
        </>
    );
}

/** The draft against the chapters: pick chapters, apply them or put them back. */
function DraftReview(props: { novelId: number; chatId: string; onClose: () => void; onDone: (note: string, applied: boolean) => void }) {
    const { novelId, chatId } = props;
    const [data, setData] = useState<{ changes: DraftChange[]; total: number } | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [pending, start] = useTransition();

    const load = useCallback(
        () =>
            start(async () => {
                const res = await getDraftChanges(novelId, chatId);
                if (!res.ok) return void toast.error(res.error);
                setData(res.data!);
                // chapters changed meanwhile are not picked: applying them would overwrite that change
                setSelected(new Set(res.data!.changes.filter((c) => !c.conflict).map((c) => c.chapter)));
            }),
        [novelId, chatId]
    );
    useEffect(load, [load]);

    const picked = [...selected].sort((a, b) => a - b);
    const list = (xs: number[]) => (xs.length > 12 ? `${xs.slice(0, 12).join(", ")} and ${xs.length - 12} more` : xs.join(", "));

    function apply() {
        start(async () => {
            const res = await applyDraftChanges(novelId, chatId, picked);
            if (!res.ok) return void toast.error(res.error);
            const { applied, skipped } = res.data!;
            toast.success(`${plural(applied.length, "chapter")} saved`);
            props.onDone(
                `[I applied chapters ${list(applied) || "none"}.${skipped.length ? ` Not applied: ${skipped.map((s) => `${s.chapter} (${s.reason})`).join(", ")}.` : ""}]`,
                applied.length > 0
            );
            load();
        });
    }

    function discard() {
        start(async () => {
            const res = await discardDraftChanges(novelId, chatId, picked);
            if (!res.ok) return void toast.error(res.error);
            props.onDone(`[I discarded the changes in chapters ${list(picked)}.]`, false);
            load();
        });
    }

    const changes = data?.changes ?? [];
    return (
        <div className="grid max-h-[60%] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2 rounded-xl border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <FileDiff className="size-4 text-brand" />
                    {data ? (data.total ? `${plural(data.total, "chapter")} changed in the draft` : "The draft has no changes") : "Loading the draft…"}
                    {data && data.total > changes.length && <span className="text-xs font-normal text-muted-foreground">(the first {changes.length} shown)</span>}
                </div>
                <div className="flex items-center gap-2">
                    {changes.length > 0 && (
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Checkbox
                                checked={selected.size === changes.length}
                                indeterminate={selected.size > 0 && selected.size < changes.length}
                                onCheckedChange={(v) => setSelected(v === true ? new Set(changes.map((c) => c.chapter)) : new Set())}
                            />
                            All
                        </label>
                    )}
                    <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={props.onClose}>
                        <X />
                    </Button>
                </div>
            </div>
            <ul className="grid content-start gap-1.5 overflow-y-auto">
                {changes.map((c) => (
                    <li key={c.chapter} className="grid gap-1 rounded-lg border px-3 py-2 text-xs">
                        <label className="flex items-center gap-2">
                            <Checkbox
                                checked={selected.has(c.chapter)}
                                onCheckedChange={(v) =>
                                    setSelected((s) => {
                                        const next = new Set(s);
                                        if (v === true) next.add(c.chapter);
                                        else next.delete(c.chapter);
                                        return next;
                                    })
                                }
                            />
                            <span className="font-medium tabular-nums">Chapter {c.chapter}</span>
                            {c.conflict && <span className="text-destructive">changed since the draft was made: applying is refused</span>}
                        </label>
                        {c.title && (
                            <p className="break-words">
                                <span className="text-muted-foreground">Title: </span>
                                <Segments segments={c.title.segments} />
                            </p>
                        )}
                        {c.hunks.map((h, i) => (
                            <div key={i} className="grid gap-0.5 border-l-2 pl-2">
                                {h.lines.map((l, j) => (
                                    <p key={j} className="break-words">
                                        <Segments segments={l} />
                                    </p>
                                ))}
                            </div>
                        ))}
                        {c.moreHunks > 0 && <p className="text-muted-foreground">and {plural(c.moreHunks, "more change")}</p>}
                    </li>
                ))}
            </ul>
            {changes.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={apply} disabled={pending || !picked.length}>
                        {pending ? <Loader2 className="animate-spin" /> : <Check />}
                        Apply {plural(picked.length, "chapter")}
                    </Button>
                    <Button size="sm" variant="outline" disabled={pending || !picked.length} onClick={discard}>
                        <Undo2 />
                        Discard {plural(picked.length, "chapter")}
                    </Button>
                </div>
            )}
        </div>
    );
}
