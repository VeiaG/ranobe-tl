import { cn } from "@/lib/utils";

/** A book with a line of glyphs turning into a line of letters. */
export function LogoMark({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
            <rect x="1" y="1" width="30" height="30" rx="8" className="fill-primary" />
            <path d="M8 10.5c2.6-1.2 5.2-1.2 8 .4 2.8-1.6 5.4-1.6 8-.4v11c-2.6-1.2-5.2-1.2-8 .4-2.8-1.6-5.4-1.6-8-.4z" className="fill-none stroke-primary-foreground" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M16 10.9v11.4" className="stroke-primary-foreground" strokeWidth="1.6" />
            <path d="M10.3 14.2h3.4M10.3 17.2h2.4" className="stroke-primary-foreground/60" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M18.3 14.2h3.4M18.3 17.2h3.4" className="stroke-brand" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
    );
}

export function Logo({ className }: { className?: string }) {
    return (
        <span className={cn("flex items-center gap-2.5 font-semibold tracking-tight", className)}>
            <LogoMark />
            <span>
                ranobe<span className="text-brand">·</span>tl
            </span>
        </span>
    );
}
