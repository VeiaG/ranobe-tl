import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { listNovels, pendingDecisionCount } from "@/server/queries";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
    const user = await requireUser();
    const [novels, pending, jar] = await Promise.all([listNovels(), pendingDecisionCount(), cookies()]);
    return (
        <AppShell
            user={{ name: user.name, email: user.email, role: user.role }}
            novels={novels.map((n) => ({ id: n.id, title: n.title, status: n.status, done: n.done, total: n.total }))}
            pending={pending}
            defaultOpen={jar.get("sidebar_state")?.value !== "false"}
        >
            {children}
        </AppShell>
    );
}
