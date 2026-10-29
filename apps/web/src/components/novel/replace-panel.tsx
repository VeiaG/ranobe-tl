"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Replace, Search } from "lucide-react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn, plural } from "@/lib/utils";
import { replaceInChapters, type ReplaceMatch } from "@/server/actions/replace";

interface Result {
    dryRun: boolean;
    matches: ReplaceMatch[];
    total: number;
    changed: number;
}

/** Find and replace over all translated chapters: preview first, then apply. */
export function ReplacePanel({ novelId, chapters }: { novelId: number; chapters: number }) {
    const router = useRouter();
    const [find, setFind] = useState("");
    const [replace, setReplace] = useState("");
    const [useRegex, setUseRegex] = useState(false);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [preserveCase, setPreserveCase] = useState(true);
    const [inTitles, setInTitles] = useState(true);
    const [inContent, setInContent] = useState(true);
    const [result, setResult] = useState<Result | null>(null);
    const [confirm, setConfirm] = useState(false);
    const [pending, start] = useTransition();

    const input = { find, replace, useRegex, caseSensitive, preserveCase, inTitles, inContent };
    // a preview belongs to the inputs it was made with
    const [previewed, setPreviewed] = useState("");
    const fresh = result?.dryRun && previewed === JSON.stringify(input);

    function run(dryRun: boolean) {
        start(async () => {
            const res = await replaceInChapters(novelId, { ...input, dryRun });
            if (!res.ok) return void toast.error(res.error);
            setResult(res.data!);
            setPreviewed(dryRun ? JSON.stringify(input) : "");
            if (!dryRun) {
                toast.success(`Replaced ${plural(res.data!.total, "match", "matches")} in ${plural(res.data!.changed, "chapter")}`);
                router.refresh();
            }
        });
    }

    const example = replace || "replacement";
    return (
        <div className="grid gap-5">
            <div className="grid gap-4 rounded-xl border p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                        <Label htmlFor="replace-find">Find</Label>
                        <Input
                            id="replace-find"
                            value={find}
                            onChange={(e) => setFind(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && find && run(true)}
                            placeholder={useRegex ? "regular expression" : "text"}
                            className={cn(useRegex && "font-mono")}
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="replace-with">Replace with</Label>
                        <Input id="replace-with" value={replace} onChange={(e) => setReplace(e.target.value)} placeholder="empty deletes the matches" className={cn(useRegex && "font-mono")} />
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
                    <label className="flex items-center gap-2">
                        <Checkbox checked={inTitles} onCheckedChange={(v) => setInTitles(v === true)} />
                        Titles
                    </label>
                    <label className="flex items-center gap-2">
                        <Checkbox checked={inContent} onCheckedChange={(v) => setInContent(v === true)} />
                        Text
                    </label>
                    <label className="flex items-center gap-2">
                        <Switch checked={useRegex} onCheckedChange={setUseRegex} />
                        Regular expression
                    </label>
                    <label className="flex items-center gap-2">
                        <Switch checked={caseSensitive} onCheckedChange={setCaseSensitive} />
                        Match case
                    </label>
                    <label className={cn("flex items-center gap-2", caseSensitive && "text-muted-foreground/60")}>
                        <Switch checked={preserveCase && !caseSensitive} onCheckedChange={setPreserveCase} disabled={caseSensitive} />
                        Keep the case
                    </label>
                </div>
                <p className="text-xs text-muted-foreground">
                    {caseSensitive ? (
                        "“Keep the case” works only when the case does not have to match: otherwise every match is written exactly like the query."
                    ) : preserveCase ? (
                        <>
                            “Keep the case” follows each match: <code>word</code> → <code>{example.toLowerCase()}</code>, <code>Word</code> →{" "}
                            <code>{example.replace(/\p{L}/u, (l) => l.toUpperCase())}</code>, <code>WORD</code> → <code>{example.toUpperCase()}</code>.
                        </>
                    ) : (
                        "Every match becomes the replacement exactly as typed."
                    )}{" "}
                    {useRegex && (
                        <>
                            Groups go in as <code>$1</code>, <code>$&lt;name&gt;</code>, the whole match as <code>$&amp;</code>.
                        </>
                    )}{" "}
                    Only translated chapters are changed ({plural(chapters, "chapter")}); each old text stays in the chapter&apos;s history.
                </p>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => run(true)} disabled={pending || !find || (!inTitles && !inContent)}>
                        {pending && !confirm ? <Loader2 className="animate-spin" /> : <Search />}
                        Preview
                    </Button>
                    <Button onClick={() => setConfirm(true)} disabled={pending || !fresh || !result?.total}>
                        <Replace />
                        Replace all
                    </Button>
                </div>
            </div>

            {result && (
                <div className="grid gap-3">
                    <div className="text-sm">
                        {!result.dryRun ? (
                            <span className="font-medium text-success">
                                Done: replaced {plural(result.total, "match", "matches")} in {plural(result.changed, "chapter")}.
                            </span>
                        ) : result.total === 0 ? (
                            <span className="text-muted-foreground">Nothing found.</span>
                        ) : (
                            <span>
                                {plural(result.total, "match", "matches")} in {plural(result.changed, "chapter")}.
                                {result.changed > result.matches.length && <span className="text-muted-foreground"> The first {result.matches.length} are shown.</span>}
                            </span>
                        )}
                    </div>
                    {result.matches.map((m) => (
                        <div key={m.index} className="grid gap-2 rounded-lg border p-3 text-sm">
                            <div className="flex items-center gap-2">
                                <Link href={`/novels/${novelId}/chapters/${m.index}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                                    <span className="text-muted-foreground tabular-nums">{m.index}.</span> {m.title}
                                </Link>
                                <Badge variant="secondary" className="shrink-0">
                                    {plural(m.count, "match", "matches")}
                                </Badge>
                            </div>
                            {m.titleAfter !== null && <Change before={m.title} after={m.titleAfter} applied={!result.dryRun} label="Title" />}
                            {m.before !== null && <Change before={m.before} after={m.after ?? ""} applied={!result.dryRun} label="Text" />}
                        </div>
                    ))}
                </div>
            )}

            <AlertDialog open={confirm} onOpenChange={setConfirm}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Replace in {result ? plural(result.changed, "chapter") : "chapters"}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {result ? `${plural(result.total, "match", "matches")} will be replaced.` : ""} The previous text of every changed chapter is kept in its history, so a chapter can be restored from there.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                setConfirm(false);
                                run(false);
                            }}
                        >
                            Replace all
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function Change({ before, after, applied, label }: { before: string; after: string; applied: boolean; label: string }) {
    return (
        <div className="grid gap-1 text-xs">
            <div className="flex gap-2">
                <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
                <span className="break-words whitespace-pre-wrap text-destructive/90">{before}</span>
            </div>
            <div className="flex gap-2">
                <span className="w-14 shrink-0 text-muted-foreground">{applied ? "now" : "becomes"}</span>
                <span className="break-words whitespace-pre-wrap text-success">{after || <em className="text-muted-foreground">empty</em>}</span>
            </div>
        </div>
    );
}
