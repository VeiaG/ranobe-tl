"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { ChevronsUpDown, LogOut, Monitor, Moon, Sun } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export function UserMenu({ user }: { user: { name: string; email: string; role: string } }) {
    const router = useRouter();
    const { theme, setTheme } = useTheme();
    const initials = user.name
        .split(/\s+/)
        .map((p) => p[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
                <span className="flex size-8 items-center justify-center rounded-md bg-brand/15 text-xs font-semibold text-brand">{initials || "?"}</span>
                <span className="grid min-w-0 flex-1 leading-tight">
                    <span className="truncate text-sm font-medium">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user.role === "admin" ? "Admin" : user.email}</span>
                </span>
                <ChevronsUpDown className="size-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuGroup>
                    <DropdownMenuLabel className="font-normal">
                        <div className="text-sm font-medium text-foreground">{user.name}</div>
                        <div className="text-xs text-muted-foreground">{user.email}</div>
                    </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <div className="flex gap-1 px-1 py-1">
                    {[
                        { value: "light", icon: Sun },
                        { value: "dark", icon: Moon },
                        { value: "system", icon: Monitor },
                    ].map(({ value, icon: Icon }) => (
                        <button
                            key={value}
                            onClick={() => setTheme(value)}
                            className={cn(
                                "flex h-7 flex-1 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
                                theme === value && "bg-accent text-foreground"
                            )}
                            aria-label={`${value} theme`}
                        >
                            <Icon className="size-4" />
                        </button>
                    ))}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    onClick={async () => {
                        await authClient.signOut();
                        router.replace("/sign-in");
                        router.refresh();
                    }}
                >
                    <LogOut />
                    Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
