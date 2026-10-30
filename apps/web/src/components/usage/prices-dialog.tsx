"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { savePrices } from "@/server/actions/usage";

interface Price {
    input: number;
    cachedInput: number;
    output: number;
}

type Draft = Record<string, { input: string; cachedInput: string; output: string }>;

const toDraft = (p?: Price) => ({ input: p ? String(p.input) : "", cachedInput: p ? String(p.cachedInput) : "", output: p ? String(p.output) : "" });

/** USD per 1M tokens per model; models from the history are listed even without a price. */
export function PricesDialog({ prices, models, isAdmin }: { prices: Record<string, Price>; models: string[]; isAdmin: boolean }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [pending, start] = useTransition();
    const initial = useMemo(() => {
        // "<model>:batch" is priced from its model (half price), it has no row of its own
        const names = [...new Set([...models.filter((m) => !m.endsWith(":batch")), ...Object.keys(prices)])];
        // used models first, then the rest alphabetically
        names.sort((a, b) => Number(!models.includes(a)) - Number(!models.includes(b)) || a.localeCompare(b));
        return Object.fromEntries(names.map((m) => [m, toDraft(prices[m])])) as Draft;
    }, [prices, models]);
    const [draft, setDraft] = useState<Draft>(initial);
    const [newModel, setNewModel] = useState("");

    const set = (model: string, field: keyof Price, value: string) => setDraft((d) => ({ ...d, [model]: { ...d[model], [field]: value } }));

    return (
        <>
            <Button
                variant="outline"
                onClick={() => {
                    setDraft(initial);
                    setOpen(true);
                }}
            >
                <Tags />
                Prices
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Prices</DialogTitle>
                        <DialogDescription>
                            USD per 1M tokens. Claude models come with Anthropic&apos;s list prices; set the others (OpenAI, Google, OpenRouter) from your provider&apos;s
                            page. Cached input is what a cache read costs instead of the normal input price.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="scrollbar-thin max-h-[50vh] overflow-y-auto rounded-lg border">
                        <div className="sticky top-0 grid grid-cols-[1fr_5.5rem_5.5rem_5.5rem] gap-2 border-b bg-muted px-3 py-2 text-xs font-medium text-muted-foreground">
                            <span>Model</span>
                            <span className="text-right">Input</span>
                            <span className="text-right">Cached</span>
                            <span className="text-right">Output</span>
                        </div>
                        {Object.entries(draft).map(([model, p]) => (
                            <div key={model} className="grid grid-cols-[1fr_5.5rem_5.5rem_5.5rem] items-center gap-2 border-b px-3 py-1.5 last:border-0">
                                <span className="truncate font-mono text-xs">
                                    {model}
                                    {models.includes(model) && <span className="ml-1.5 font-sans text-[10px] text-brand">used</span>}
                                </span>
                                {(["input", "cachedInput", "output"] as const).map((f) => (
                                    <Input key={f} value={p[f]} onChange={(e) => set(model, f, e.target.value)} inputMode="decimal" placeholder="—" disabled={!isAdmin} className="h-7 text-right font-mono text-xs" />
                                ))}
                            </div>
                        ))}
                    </div>
                    {isAdmin && (
                        <form
                            className="flex gap-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                const m = newModel.trim();
                                if (m && !draft[m]) setDraft((d) => ({ ...d, [m]: toDraft() }));
                                setNewModel("");
                            }}
                        >
                            <Input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="model id, e.g. gpt-6-luna" className="font-mono text-sm" />
                            <Button type="submit" variant="outline">
                                <Plus />
                                Add
                            </Button>
                        </form>
                    )}
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setOpen(false)}>
                            Close
                        </Button>
                        {isAdmin && (
                            <Button
                                disabled={pending}
                                onClick={() =>
                                    start(async () => {
                                        const out: Record<string, Price | null> = {};
                                        for (const [m, p] of Object.entries(draft)) {
                                            if (!p.input && !p.cachedInput && !p.output) continue;
                                            const input = Number(p.input || 0);
                                            out[m] = { input, cachedInput: p.cachedInput === "" ? input : Number(p.cachedInput), output: Number(p.output || 0) };
                                        }
                                        const res = await savePrices(out);
                                        if (!res.ok) return void toast.error(res.error);
                                        toast.success(res.message ?? "Saved");
                                        setOpen(false);
                                        router.refresh();
                                    })
                                }
                            >
                                {pending && <Loader2 className="animate-spin" />}
                                Save prices
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
