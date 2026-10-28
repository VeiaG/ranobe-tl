"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Inbox, LayoutGrid, Menu, Plus, Settings, X } from "lucide-react";
import { Logo } from "@/components/logo";
import { NovelStatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";
import type { NovelStatus } from "@/db/schema";
import { cn } from "@/lib/utils";

export interface ShellProps {
    user: { name: string; email: string; role: string };
    novels: { id: number; title: string; status: NovelStatus; done: number; total: number }[];
    pending: number;
    children: React.ReactNode;
}

function NavLink({ href, icon: Icon, children, badge, exact }: { href: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; badge?: number; exact?: boolean }) {
    const pathname = usePathname();
    const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
    return (
        <Link
            href={href}
            className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                active && "bg-accent font-medium text-foreground"
            )}
        >
            <Icon className="size-4" />
            <span className="flex-1 truncate">{children}</span>
            {!!badge && <span className="rounded-full bg-warning/20 px-1.5 text-[11px] font-semibold tabular-nums text-[color-mix(in_oklch,var(--warning)_75%,var(--foreground))]">{badge}</span>}
        </Link>
    );
}

function Sidebar({ user, novels, pending }: Omit<ShellProps, "children">) {
    const pathname = usePathname();
    return (
        <div className="flex h-full flex-col">
            <div className="flex h-14 items-center px-4">
                <Link href="/">
                    <Logo />
                </Link>
            </div>
            <nav className="grid gap-0.5 px-2.5">
                <NavLink href="/" icon={LayoutGrid} exact>
                    Dashboard
                </NavLink>
                <NavLink href="/decisions" icon={Inbox} badge={pending}>
                    Decisions
                </NavLink>
                <NavLink href="/settings" icon={Settings}>
                    Settings
                </NavLink>
            </nav>
            <div className="mt-6 flex items-center justify-between px-5 pb-1.5">
                <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Novels</span>
                <Button asChild variant="ghost" size="icon-xs" className="-mr-1.5 text-muted-foreground">
                    <Link href="/novels/new" aria-label="New novel">
                        <Plus />
                    </Link>
                </Button>
            </div>
            <div className="scrollbar-thin grid flex-1 content-start gap-0.5 overflow-y-auto px-2.5 pb-4">
                {novels.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">Nothing here yet.</p>}
                {novels.map((n) => {
                    const href = `/novels/${n.id}`;
                    const active = pathname === href || pathname.startsWith(`${href}/`);
                    return (
                        <Link
                            key={n.id}
                            href={href}
                            className={cn(
                                "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                                active && "bg-accent font-medium text-foreground"
                            )}
                        >
                            <NovelStatusDot status={n.status} />
                            <span className="flex-1 truncate">{n.title}</span>
                            <span className="text-[11px] tabular-nums text-muted-foreground/70">{n.total ? Math.floor((n.done / n.total) * 100) : 0}%</span>
                        </Link>
                    );
                })}
            </div>
            <div className="border-t border-sidebar-border p-2.5">
                <UserMenu user={user} />
            </div>
        </div>
    );
}

export function AppShell(props: ShellProps) {
    const [open, setOpen] = useState(false);
    const pathname = usePathname();
    const [lastPath, setLastPath] = useState(pathname);
    if (pathname !== lastPath) {
        setLastPath(pathname);
        setOpen(false);
    }
    return (
        <div className="flex min-h-dvh">
            <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
                <Sidebar {...props} />
            </aside>
            {open && (
                <div className="fixed inset-0 z-40 md:hidden">
                    <div className="absolute inset-0 bg-black/40 animate-in fade-in-0" onClick={() => setOpen(false)} />
                    <aside className="absolute inset-y-0 left-0 w-64 border-r bg-sidebar shadow-xl animate-in slide-in-from-left">
                        <Button variant="ghost" size="icon-sm" className="absolute top-3 right-2" onClick={() => setOpen(false)} aria-label="Close menu">
                            <X />
                        </Button>
                        <Sidebar {...props} />
                    </aside>
                </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur md:hidden">
                    <Button variant="ghost" size="icon-sm" onClick={() => setOpen(true)} aria-label="Open menu">
                        <Menu />
                    </Button>
                    <Link href="/">
                        <Logo />
                    </Link>
                    {props.pending > 0 && (
                        <Button asChild variant="ghost" size="sm" className="ml-auto">
                            <Link href="/decisions">
                                <Inbox />
                                {props.pending}
                            </Link>
                        </Button>
                    )}
                </header>
                <main className="flex-1">{props.children}</main>
            </div>
        </div>
    );
}
