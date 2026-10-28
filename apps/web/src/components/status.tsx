import { CircleAlert, CircleCheck, CircleDashed, CirclePause, Clock, Hourglass, Loader2, SkipForward } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ChapterStatus, NovelStatus } from "@/db/schema";
import { cn } from "@/lib/utils";

const NOVEL: Record<NovelStatus, { label: string; variant: "success" | "warning" | "muted" | "destructive" | "info" | "brand"; dot: string }> = {
    running: { label: "Translating", variant: "brand", dot: "bg-brand" },
    waiting: { label: "Needs decisions", variant: "warning", dot: "bg-warning" },
    paused: { label: "Paused", variant: "muted", dot: "bg-muted-foreground/60" },
    error: { label: "Stopped", variant: "destructive", dot: "bg-destructive" },
    idle: { label: "Idle", variant: "muted", dot: "bg-muted-foreground/30" },
};

export function NovelStatusBadge({ status, className }: { status: NovelStatus; className?: string }) {
    const s = NOVEL[status] ?? NOVEL.idle;
    return (
        <Badge variant={s.variant} className={className}>
            {status === "running" ? <Loader2 className="animate-spin" /> : status === "waiting" ? <Hourglass /> : status === "paused" ? <CirclePause /> : status === "error" ? <CircleAlert /> : null}
            {s.label}
        </Badge>
    );
}

export function NovelStatusDot({ status, className }: { status: NovelStatus; className?: string }) {
    const s = NOVEL[status] ?? NOVEL.idle;
    return (
        <span className={cn("relative flex size-2 shrink-0", className)}>
            {status === "running" && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", s.dot)} />}
            <span className={cn("relative inline-flex size-2 rounded-full", s.dot)} />
        </span>
    );
}

const CHAPTER: Record<ChapterStatus, { label: string; className: string; icon: React.ComponentType<{ className?: string }> }> = {
    new: { label: "Not started", className: "text-muted-foreground", icon: CircleDashed },
    queued: { label: "Queued", className: "text-info", icon: Clock },
    translating: { label: "Translating", className: "text-brand", icon: Loader2 },
    done: { label: "Done", className: "text-success", icon: CircleCheck },
    failed: { label: "Failed", className: "text-destructive", icon: CircleAlert },
    skipped: { label: "Skipped", className: "text-warning", icon: SkipForward },
};

export function ChapterStatusLabel({ status, className }: { status: ChapterStatus; className?: string }) {
    const s = CHAPTER[status] ?? CHAPTER.new;
    const Icon = s.icon;
    return (
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", s.className, className)}>
            <Icon className={cn("size-3.5", status === "translating" && "animate-spin")} />
            {s.label}
        </span>
    );
}

export function ChapterStatusIcon({ status, className }: { status: ChapterStatus; className?: string }) {
    const s = CHAPTER[status] ?? CHAPTER.new;
    const Icon = s.icon;
    return <Icon className={cn("size-3.5", s.className, status === "translating" && "animate-spin", className)} />;
}
