import Link from "next/link";
import { HardDrive, KeyRound, Send, SlidersHorizontal, Users } from "lucide-react";
import { cn } from "@/lib/utils";

export function SettingsTabs({ tab, isAdmin }: { tab: string; isAdmin: boolean }) {
    const tabs = [
        { key: "keys", label: "API keys", icon: KeyRound },
        { key: "telegram", label: "Telegram", icon: Send },
        { key: "storage", label: "Storage", icon: HardDrive },
        ...(isAdmin ? [{ key: "instance", label: "Instance", icon: SlidersHorizontal }] : []),
        ...(isAdmin ? [{ key: "users", label: "Users", icon: Users }] : []),
    ];
    return (
        <nav className="mt-6 flex gap-1 border-b">
            {tabs.map((t) => (
                <Link
                    key={t.key}
                    href={`/settings?tab=${t.key}`}
                    className={cn(
                        "-mb-px flex items-center gap-2 border-b-2 border-transparent px-3 pb-2.5 text-sm text-muted-foreground hover:text-foreground",
                        tab === t.key && "border-foreground font-medium text-foreground"
                    )}
                >
                    <t.icon className="size-4" />
                    {t.label}
                </Link>
            ))}
        </nav>
    );
}
