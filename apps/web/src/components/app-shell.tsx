"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { ChartColumn, Inbox, LayoutGrid, Plus, Settings } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { NovelStatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupAction,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarRail,
    SidebarTrigger,
    useSidebar,
} from "@/components/ui/sidebar";
import { UserMenu } from "@/components/user-menu";
import type { NovelStatus } from "@/db/schema";

export interface ShellProps {
    user: { name: string; email: string; role: string };
    novels: { id: number; title: string; status: NovelStatus; done: number; total: number }[];
    pending: number;
    defaultOpen: boolean;
    children: React.ReactNode;
}

const NAV = [
    { href: "/", label: "Dashboard", icon: LayoutGrid, exact: true },
    { href: "/decisions", label: "Decisions", icon: Inbox },
    { href: "/usage", label: "Usage", icon: ChartColumn },
    { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string, exact?: boolean) {
    return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function AppSidebar({ user, novels, pending }: Omit<ShellProps, "children" | "defaultOpen">) {
    const pathname = usePathname();
    const { setOpenMobile } = useSidebar();

    // the mobile sheet closes after navigating
    useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);

    return (
        <Sidebar collapsible="icon" variant="inset">
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton size="lg" render={<Link href="/" />} className="hover:bg-transparent active:bg-transparent">
                            <LogoMark className="size-8 shrink-0" />
                            <span className="grid leading-tight group-data-[collapsible=icon]:hidden">
                                <span className="font-semibold tracking-tight">
                                    ranobe<span className="text-brand">·</span>tl
                                </span>
                                <span className="text-xs text-muted-foreground">translation workspace</span>
                            </span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {NAV.map((item) => (
                                <SidebarMenuItem key={item.href}>
                                    <SidebarMenuButton render={<Link href={item.href} />} isActive={isActive(pathname, item.href, item.exact)} tooltip={item.label}>
                                        <item.icon />
                                        <span>{item.label}</span>
                                    </SidebarMenuButton>
                                    {item.href === "/decisions" && pending > 0 && (
                                        <SidebarMenuBadge className="bg-brand/15 text-brand peer-data-active/menu-button:text-brand">{pending}</SidebarMenuBadge>
                                    )}
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                <SidebarGroup className="group-data-[collapsible=icon]:hidden">
                    <SidebarGroupLabel>Novels</SidebarGroupLabel>
                    <SidebarGroupAction render={<Link href="/novels/new" />} title="New novel">
                        <Plus />
                        <span className="sr-only">New novel</span>
                    </SidebarGroupAction>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {novels.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Nothing here yet.</p>}
                            {novels.map((n) => {
                                const href = `/novels/${n.id}`;
                                const pct = n.total ? Math.floor((n.done / n.total) * 100) : 0;
                                return (
                                    <SidebarMenuItem key={n.id}>
                                        <SidebarMenuButton render={<Link href={href} />} isActive={isActive(pathname, href)} className="h-auto py-1.5">
                                            <NovelStatusDot status={n.status} className="mt-0.5 self-start" />
                                            <span className="grid min-w-0 flex-1 gap-1">
                                                <span className="truncate">{n.title}</span>
                                                <span className="flex items-center gap-2">
                                                    <span className="h-0.5 flex-1 overflow-hidden rounded-full bg-sidebar-border">
                                                        <span className="block h-full rounded-full bg-brand/80" style={{ width: `${pct}%` }} />
                                                    </span>
                                                    <span className="w-8 text-right text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
                                                </span>
                                            </span>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                );
                            })}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                <UserMenu user={user} />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}

export function AppShell({ defaultOpen, children, ...props }: ShellProps) {
    return (
        <SidebarProvider defaultOpen={defaultOpen}>
            <AppSidebar {...props} />
            <SidebarInset className="min-w-0">
                <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
                    <SidebarTrigger className="-ml-1" />
                    {props.pending > 0 && (
                        <Button variant="ghost" size="sm" className="ml-auto text-brand" nativeButton={false} render={<Link href="/decisions" />}>
                            <Inbox />
                            {props.pending} to decide
                        </Button>
                    )}
                </header>
                <div className="flex-1">{children}</div>
            </SidebarInset>
        </SidebarProvider>
    );
}
