import { desc, eq, isNull, gt, and } from "drizzle-orm";
import { Page, PageHeader } from "@/components/page-header";
import { KeysPanel } from "@/components/settings/keys-panel";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { TelegramPanel } from "@/components/settings/telegram-panel";
import { UsersPanel } from "@/components/settings/users-panel";
import { db } from "@/db";
import { invite, telegramLink, user } from "@/db/schema";
import { listKeys } from "@/server/queries";
import { getSetting } from "@/server/settings";
import { STORAGE_STATUS_DEFAULTS, STORAGE_STATUS_KEY, storageConfig } from "@/server/storage/client";
import { StoragePanel } from "@/components/settings/storage-panel";
import { requireUser } from "@/server/session";
import { botUsername } from "@/server/telegram-info";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
    const me = await requireUser();
    const isAdmin = me.role === "admin";
    const { tab: rawTab } = await searchParams;
    const tab = ["keys", "telegram", "storage", "users"].includes(rawTab ?? "") && (rawTab !== "users" || isAdmin) ? rawTab! : "keys";

    let content: React.ReactNode;
    if (tab === "keys") {
        content = <KeysPanel keys={(await listKeys()).map((k) => ({ ...k, createdAt: k.createdAt.toISOString() }))} isAdmin={isAdmin} />;
    } else if (tab === "storage") {
        const [config, status] = await Promise.all([storageConfig(db), getSetting(db, STORAGE_STATUS_KEY, STORAGE_STATUS_DEFAULTS)]);
        const { secretEncrypted, ...rest } = config;
        content = <StoragePanel config={{ ...rest, hasSecret: !!secretEncrypted }} status={status} isAdmin={isAdmin} />;
    } else if (tab === "telegram") {
        const [link] = await db.select().from(telegramLink).where(eq(telegramLink.userId, me.id));
        content = (
            <TelegramPanel
                configured={!!process.env.TELEGRAM_BOT_TOKEN}
                bot={await botUsername()}
                link={
                    link
                        ? {
                              linked: !!link.chatId,
                              username: link.username,
                              token: link.linkToken,
                              notifyDecisions: link.notifyDecisions,
                              notifyFailures: link.notifyFailures,
                              notifyFinished: link.notifyFinished,
                              linkedAt: link.linkedAt?.toISOString() ?? null,
                          }
                        : null
                }
            />
        );
    } else {
        const [users, invites] = await Promise.all([
            db.select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt }).from(user).orderBy(user.createdAt),
            db
                .select()
                .from(invite)
                .where(and(isNull(invite.usedAt), gt(invite.expiresAt, new Date())))
                .orderBy(desc(invite.createdAt)),
        ]);
        content = (
            <UsersPanel
                meId={me.id}
                users={users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }))}
                invites={invites.map((i) => ({ token: i.token, note: i.note, expiresAt: i.expiresAt.toISOString() }))}
            />
        );
    }

    return (
        <Page className="max-w-4xl">
            <PageHeader title="Settings" description="API keys, notifications, backups and who can use this instance." />
            <SettingsTabs tab={tab} isAdmin={isAdmin} />
            <div className="mt-6">{content}</div>
        </Page>
    );
}
