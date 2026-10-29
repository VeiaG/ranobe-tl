import { cn } from "@/lib/utils";

export function PageHeader({
    title,
    description,
    actions,
    className,
    children,
}: {
    title: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
    children?: React.ReactNode;
}) {
    return (
        <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
            <div className="min-w-0 space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                {description && <div className="text-sm text-muted-foreground">{description}</div>}
                {children}
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}

export function Page({ className, children }: { className?: string; children: React.ReactNode }) {
    return <div className={cn("mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8", className)}>{children}</div>;
}

export function StatCard({ label, value, hint, icon: Icon, className }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ComponentType<{ className?: string }>; className?: string }) {
    return (
        <div className={cn("rounded-xl border bg-card p-4 shadow-xs", className)}>
            <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                {label}
                {Icon && <Icon className="size-4 text-muted-foreground/70" />}
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
            {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
        </div>
    );
}

export function EmptyState({ icon: Icon, title, description, children, className }: { icon: React.ComponentType<{ className?: string }>; title: string; description?: React.ReactNode; children?: React.ReactNode; className?: string }) {
    return (
        <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center", className)}>
            <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Icon className="size-5" />
            </div>
            <h3 className="font-medium">{title}</h3>
            {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
            {children && <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>}
        </div>
    );
}
