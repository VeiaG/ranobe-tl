import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatTokens } from "@/lib/utils";
import { formatUsd } from "@/server/pricing";

interface ModelRow {
    model: string;
    provider: string;
    color: string;
    requests: number;
    failed: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cost: number;
    wasted: number;
}

interface NovelRow {
    novelId: number | null;
    title: string;
    chapters: number;
    cost: number;
    tokens: number;
    models: string[];
}

/** The numbers behind the chart, as text (also the accessible view of it). */
export function UsageTables({ models, novels }: { models: ModelRow[]; novels: NovelRow[] }) {
    return (
        <div className="grid gap-6 xl:grid-cols-2">
            <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
                <div className="border-b px-4 py-3 text-sm font-medium">By model</div>
                <Table>
                    <TableHeader>
                        <TableRow className="hover:bg-transparent">
                            <TableHead className="pl-4">Model</TableHead>
                            <TableHead className="text-right">Requests</TableHead>
                            <TableHead className="text-right">Tokens</TableHead>
                            <TableHead className="text-right">Rejected</TableHead>
                            <TableHead className="pr-4 text-right">Cost</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {models.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                                    Nothing yet.
                                </TableCell>
                            </TableRow>
                        )}
                        {models.map((m) => (
                            <TableRow key={m.model}>
                                <TableCell className="pl-4">
                                    <div className="flex items-center gap-2">
                                        <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: m.color }} />
                                        <span className="font-mono text-xs">{m.model}</span>
                                    </div>
                                    <div className="pl-[18px] text-xs text-muted-foreground">{m.provider}</div>
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(m.requests)}</TableCell>
                                <TableCell className="text-right text-xs tabular-nums">
                                    {formatTokens(m.inputTokens)} / {formatTokens(m.outputTokens)}
                                    {m.cachedTokens > 0 && <div className="text-muted-foreground">{Math.round((m.cachedTokens / Math.max(1, m.inputTokens)) * 100)}% cached</div>}
                                </TableCell>
                                <TableCell className="text-right text-xs tabular-nums">
                                    {m.requests ? `${Math.round((m.failed / m.requests) * 100)}%` : "—"}
                                    {m.wasted > 0 && <div className="text-muted-foreground">{formatUsd(m.wasted)}</div>}
                                </TableCell>
                                <TableCell className="pr-4 text-right font-medium tabular-nums">{formatUsd(m.cost)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
            <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
                <div className="border-b px-4 py-3 text-sm font-medium">By novel</div>
                <Table>
                    <TableHeader>
                        <TableRow className="hover:bg-transparent">
                            <TableHead className="pl-4">Novel</TableHead>
                            <TableHead className="text-right">Chapters</TableHead>
                            <TableHead className="text-right">Per chapter</TableHead>
                            <TableHead className="pr-4 text-right">Cost</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {novels.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                                    Nothing yet.
                                </TableCell>
                            </TableRow>
                        )}
                        {novels.map((n) => (
                            <TableRow key={`${n.novelId}:${n.title}`}>
                                <TableCell className="max-w-0 pl-4 whitespace-normal">
                                    {n.novelId ? (
                                        <Link href={`/novels/${n.novelId}`} className="block truncate font-medium hover:text-brand">
                                            {n.title}
                                        </Link>
                                    ) : (
                                        <span className="block truncate text-muted-foreground">{n.title}</span>
                                    )}
                                    <div className="truncate font-mono text-[11px] text-muted-foreground">{n.models.join(", ")}</div>
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(n.chapters)}</TableCell>
                                <TableCell className="text-right tabular-nums">{n.chapters ? formatUsd(n.cost / n.chapters) : "—"}</TableCell>
                                <TableCell className="pr-4 text-right font-medium tabular-nums">{formatUsd(n.cost)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
