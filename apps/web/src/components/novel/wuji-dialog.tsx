"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { BookOpen, Check, Loader2, LogIn, Search, Upload } from "lucide-react";
import type { WujiProgress } from "@/app/api/novels/[id]/wuji/route";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, formatNumber } from "@/lib/utils";
import { wujiSearchBooks, wujiSignIn } from "@/server/actions/wuji";
import type { WujiBook } from "@/server/wuji";

interface Run {
    total: number;
    done: number;
    last: string | null;
    error: string | null;
    finished: boolean;
}

/**
 * Publishes translated chapters to a book on wuji.world. The sign-in lives only as long as the dialog:
 * nothing about the account is saved.
 */
export function WujiDialog({ novelId, open, onOpenChange }: { novelId: number; open: boolean; onOpenChange: (v: boolean) => void }) {
    const [session, setSession] = useState<{ token: string; name: string } | null>(null);
    const [mode, setMode] = useState("password");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [token, setToken] = useState("");
    const [q, setQ] = useState("");
    const [books, setBooks] = useState<WujiBook[] | null>(null);
    const [book, setBook] = useState<WujiBook | null>(null);
    const [from, setFrom] = useState("1");
    const [to, setTo] = useState("");
    const [run, setRun] = useState<Run | null>(null);
    const [pending, start] = useTransition();
    const abort = useRef<AbortController | null>(null);
    const uploading = run !== null && !run.finished;

    // closing the dialog forgets the account and stops an upload in flight
    function close(v: boolean) {
        if (!v) {
            abort.current?.abort();
            setSession(null);
            setPassword("");
            setToken("");
            setBook(null);
            setBooks(null);
            setRun(null);
        }
        onOpenChange(v);
    }

    function signIn() {
        start(async () => {
            const res = await wujiSignIn(mode === "token" ? { token } : { email, password });
            if (!res.ok) return void toast.error(res.error);
            setSession(res.data!);
            setPassword("");
            setToken("");
        });
    }

    useEffect(() => {
        if (!session) return;
        const t = setTimeout(async () => {
            const res = await wujiSearchBooks(session.token, q);
            if (!res.ok) return void toast.error(res.error);
            setBooks(res.data!);
        }, 300);
        return () => clearTimeout(t);
    }, [session, q]);

    function pick(b: WujiBook) {
        setBook(b);
        // chapters already on the site are usually the first ones: continue after them
        setFrom(String(b.chapterCount + 1));
        setTo("");
        setRun(null);
    }

    async function upload() {
        if (!session || !book) return;
        const controller = new AbortController();
        abort.current = controller;
        setRun({ total: 0, done: 0, last: null, error: null, finished: false });
        try {
            const res = await fetch(`/api/novels/${novelId}/wuji`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: session.token, bookId: book.id, from: Number(from) || 1, to: Number(to) || 1_000_000_000 }),
                signal: controller.signal,
            });
            if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Upload failed");
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += value;
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines.filter(Boolean)) handle(JSON.parse(line) as WujiProgress);
            }
        } catch (error) {
            // chapters sent before the stop stay on the site
            if (controller.signal.aborted) return void setRun((r) => r && { ...r, error: "Stopped", finished: true });
            setRun((r) => ({ ...(r ?? { total: 0, done: 0, last: null }), error: error instanceof Error ? error.message : String(error), finished: true }));
        }
    }

    function handle(p: WujiProgress) {
        if (p.type === "start") {
            setRun((r) => r && { ...r, total: p.total });
            if (p.untranslated.length) toast.warning(`Not translated, left out: ${p.untranslated.length > 10 ? `${p.untranslated.slice(0, 10).join(", ")} and ${p.untranslated.length - 10} more` : p.untranslated.join(", ")}`);
        } else if (p.type === "chapter") setRun((r) => r && { ...r, done: p.done, last: `${p.index}. ${p.title}` });
        else if (p.type === "error") setRun((r) => r && { ...r, error: p.index ? `Chapter ${p.index}: ${p.message}` : p.message });
        else if (p.type === "done") {
            setRun((r) => r && { ...r, finished: true });
            setBook((b) => b && { ...b, chapterCount: b.chapterCount + p.uploaded });
            if (p.uploaded) toast.success(`${formatNumber(p.uploaded)} chapters published to wuji.world`);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(v) => (uploading && !v ? undefined : close(v))}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Publish to wuji.world</DialogTitle>
                    <DialogDescription>
                        Translated chapters are added to the end of a book on the site, in order. {session ? `Signed in as ${session.name}.` : "The sign-in is kept only while this dialog is open."}
                    </DialogDescription>
                </DialogHeader>

                {!session ? (
                    <Tabs value={mode} onValueChange={setMode}>
                        <TabsList className="w-full">
                            <TabsTrigger value="password">Email and password</TabsTrigger>
                            <TabsTrigger value="token">Token</TabsTrigger>
                        </TabsList>
                        <TabsContent value="password" className="mt-3 grid gap-3">
                            <div className="grid gap-1.5">
                                <Label htmlFor="wuji-email">Email</Label>
                                <Input id="wuji-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
                            </div>
                            <div className="grid gap-1.5">
                                <Label htmlFor="wuji-password">Password</Label>
                                <Input id="wuji-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && signIn()} />
                            </div>
                        </TabsContent>
                        <TabsContent value="token" className="mt-3 grid gap-1.5">
                            <Label htmlFor="wuji-token">Token</Label>
                            <Input id="wuji-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && signIn()} placeholder="payload-token=…" />
                            <p className="text-xs text-muted-foreground">For accounts made with Google: the value of the payload-token cookie on wuji.world (DevTools → Application → Cookies).</p>
                        </TabsContent>
                    </Tabs>
                ) : (
                    <div className="grid gap-3">
                        <div className="relative">
                            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a book" className="pl-8" disabled={uploading} />
                        </div>
                        <ul className="scrollbar-thin max-h-60 overflow-y-auto rounded-lg border py-1">
                            {books === null && (
                                <li className="flex justify-center py-6">
                                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                                </li>
                            )}
                            {books?.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No books this account can add chapters to</li>}
                            {books?.map((b) => (
                                <li key={b.id}>
                                    <button
                                        disabled={uploading}
                                        onClick={() => pick(b)}
                                        className={cn("flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-muted/50 disabled:pointer-events-none", book?.id === b.id && "bg-muted")}
                                    >
                                        {b.cover ? <img src={b.cover} alt="" className="h-10 w-7 shrink-0 rounded-sm object-cover" /> : <BookOpen className="size-4 shrink-0 text-muted-foreground" />}
                                        <span className="min-w-0 flex-1 truncate">{b.title}</span>
                                        <span className="text-xs text-muted-foreground tabular-nums">{formatNumber(b.chapterCount)} ch.</span>
                                        {book?.id === b.id && <Check className="size-4 text-brand" />}
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {book && (
                            <div className="flex flex-wrap items-end gap-3">
                                <div className="grid w-28 gap-1.5">
                                    <Label htmlFor="wuji-from">From chapter</Label>
                                    <Input id="wuji-from" type="number" min={1} value={from} onChange={(e) => setFrom(e.target.value)} disabled={uploading} />
                                </div>
                                <div className="grid w-28 gap-1.5">
                                    <Label htmlFor="wuji-to">To chapter</Label>
                                    <Input id="wuji-to" type="number" min={1} value={to} onChange={(e) => setTo(e.target.value)} placeholder="last" disabled={uploading} />
                                </div>
                                <p className="min-w-40 flex-1 pb-2 text-xs text-muted-foreground">
                                    {formatNumber(book.chapterCount)} chapters on the site; only translated ones are sent.
                                </p>
                            </div>
                        )}
                        {run && (
                            <div className="grid gap-1.5 text-sm">
                                <Progress value={run.total ? (run.done / run.total) * 100 : 0} />
                                <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                                    <span className="min-w-0 truncate">{run.last ?? (run.finished ? "" : "Starting…")}</span>
                                    <span className="tabular-nums">
                                        {formatNumber(run.done)} / {formatNumber(run.total)}
                                    </span>
                                </div>
                                {run.error && <p className="text-xs text-destructive">{run.error}</p>}
                            </div>
                        )}
                    </div>
                )}

                <DialogFooter>
                    {uploading ? (
                        <Button variant="ghost" onClick={() => abort.current?.abort()}>
                            Stop
                        </Button>
                    ) : (
                        <Button variant="ghost" onClick={() => close(false)}>
                            {run?.finished ? "Close" : "Cancel"}
                        </Button>
                    )}
                    {!session ? (
                        <Button onClick={signIn} disabled={pending || (mode === "token" ? !token.trim() : !email.trim() || !password)}>
                            {pending ? <Loader2 className="animate-spin" /> : <LogIn />}
                            Sign in
                        </Button>
                    ) : (
                        <Button onClick={upload} disabled={!book || uploading}>
                            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
                            Publish
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
