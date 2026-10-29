"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn, plural } from "@/lib/utils";
import { suggestPatterns, type PatternCheck } from "@/server/actions/cleanup";

/** Share of chapters above which a pattern probably eats story text, not junk. */
const BROAD = 0.9;

/** The ✨ next to "Patterns to remove": describe the junk, the service model writes the regexes, they are tried on every source. */
export function PatternsAssistant({ novelId, onAdd }: { novelId: number; onAdd: (patterns: string[]) => void }) {
    const [open, setOpen] = useState(false);
    const [request, setRequest] = useState("");
    const [result, setResult] = useState<{ explanation: string; checks: PatternCheck[]; chapters: number } | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [pending, start] = useTransition();

    function suggest() {
        start(async () => {
            const res = await suggestPatterns(novelId, request);
            if (!res.ok) return void toast.error(res.error);
            setResult(res.data!);
            // preselect the ones that work and look safe
            setChosen(new Set(res.data!.checks.filter((c) => !c.error && c.matches > 0 && c.chapters <= res.data!.chapters * BROAD).map((c) => c.pattern)));
        });
    }

    function add() {
        onAdd([...chosen]);
        toast.success(`${plural(chosen.size, "pattern")} added; save the settings to keep them`);
        setOpen(false);
        setResult(null);
        setRequest("");
    }

    return (
        <>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Write patterns with the service model" title="Write patterns with the service model" onClick={() => setOpen(true)}>
                <Sparkles />
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Patterns from a description</DialogTitle>
                        <DialogDescription>
                            Say what should be cut from the sources. The service model looks at lines repeated across chapters and at the start and end of a few of them, writes the patterns, and
                            each one is tried on every source of this novel.
                        </DialogDescription>
                    </DialogHeader>
                    <Textarea
                        value={request}
                        onChange={(e) => setRequest(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && request.trim() && suggest()}
                        rows={3}
                        placeholder="Lines asking to read on the translator's site, Patreon links, “Edited by …” at the end of chapters"
                    />
                    {result && (
                        <div className="grid gap-3">
                            {result.explanation && <p className="text-sm text-muted-foreground">{result.explanation}</p>}
                            {result.checks.length === 0 && <p className="text-sm text-muted-foreground">The model found nothing like that in the sources.</p>}
                            <ul className="scrollbar-thin grid max-h-96 gap-2 overflow-y-auto">
                                {result.checks.map((c) => {
                                    const broad = c.chapters > result.chapters * BROAD;
                                    return (
                                        <li key={c.pattern} className="grid gap-2 rounded-lg border p-3">
                                            <label className="flex items-start gap-2">
                                                <Checkbox
                                                    className="mt-0.5"
                                                    disabled={!!c.error}
                                                    checked={chosen.has(c.pattern)}
                                                    onCheckedChange={(v) =>
                                                        setChosen((s) => {
                                                            const next = new Set(s);
                                                            if (v === true) next.add(c.pattern);
                                                            else next.delete(c.pattern);
                                                            return next;
                                                        })
                                                    }
                                                />
                                                <code className="min-w-0 flex-1 font-mono text-xs break-all">{c.pattern}</code>
                                            </label>
                                            {c.error ? (
                                                <p className="text-xs text-destructive">{c.error}</p>
                                            ) : (
                                                <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", (broad || !c.matches) && "text-warning")}>
                                                    {(broad || !c.matches) && <AlertTriangle className="size-3.5" />}
                                                    {c.matches
                                                        ? `${plural(c.matches, "match", "matches")} in ${plural(c.chapters, "chapter")} of ${result.chapters}${broad ? ": nearly every chapter, check that it is not story text" : ""}`
                                                        : "Matches nothing in the sources"}
                                                </p>
                                            )}
                                            {c.samples.length > 0 && (
                                                <ul className="grid gap-0.5 border-l-2 pl-2 text-xs">
                                                    {c.samples.map((s) => (
                                                        <li key={s} className="truncate text-destructive/90 line-through decoration-destructive/40">
                                                            {s}
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant={result ? "outline" : "default"} onClick={suggest} disabled={pending || !request.trim()}>
                            {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
                            {result ? "Try again" : "Suggest"}
                        </Button>
                        {result && (
                            <Button type="button" onClick={add} disabled={!chosen.size}>
                                <Plus />
                                Add {chosen.size > 0 ? plural(chosen.size, "pattern") : "patterns"}
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
