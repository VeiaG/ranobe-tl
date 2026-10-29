import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";

export const INVITE_HEADER = "x-invite-token";

async function userCount(): Promise<number> {
    const [{ n }] = await db.select({ n: count() }).from(schema.user);
    return n;
}

async function validInvite(token: string | null | undefined) {
    if (!token) return undefined;
    const [row] = await db
        .select()
        .from(schema.invite)
        .where(and(eq(schema.invite.token, token), isNull(schema.invite.usedAt), gt(schema.invite.expiresAt, new Date())));
    return row;
}

const APP_URL = process.env.APP_URL || process.env.BETTER_AUTH_URL || undefined;
const EXTRA_ORIGINS = (process.env.TRUSTED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Without APP_URL the app answers on whatever address it was opened with (a Pi's LAN IP, a domain
 * behind a proxy): a request is trusted when its Origin is the host it was sent to, which is the
 * same-origin check, just without knowing the host in advance.
 */
function ownOrigins(request?: Request): string[] {
    const host = request?.headers.get("x-forwarded-host") ?? request?.headers.get("host");
    return host ? [`http://${host}`, `https://${host}`] : [];
}

/**
 * Accounts: the first one becomes the admin, everyone after that needs an invite from the admin.
 * The invite token travels in a header so that the sign-up body stays Better Auth's own.
 */
export const auth = betterAuth({
    secret: process.env.APP_SECRET || process.env.BETTER_AUTH_SECRET,
    baseURL: APP_URL,
    trustedOrigins: APP_URL ? EXTRA_ORIGINS : async (request) => [...EXTRA_ORIGINS, ...ownOrigins(request)],
    // with a known https address cookies are Secure; on a bare http://<ip>:3000 they cannot be
    advanced: APP_URL ? {} : { useSecureCookies: false },
    database: drizzleAdapter(db, {
        provider: "pg",
        schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 8, autoSignIn: true },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    user: {
        additionalFields: {
            role: { type: "string", defaultValue: "member", input: false },
        },
    },
    databaseHooks: {
        user: {
            create: {
                before: async (data) => ({ data: { ...data, role: (await userCount()) === 0 ? "admin" : "member" } }),
            },
        },
    },
    hooks: {
        before: createAuthMiddleware(async (ctx) => {
            if (ctx.path !== "/sign-up/email") return;
            if ((await userCount()) === 0) return;
            if (!(await validInvite(ctx.headers?.get(INVITE_HEADER)))) {
                throw new APIError("FORBIDDEN", { message: "Sign-up needs an invite from the admin" });
            }
        }),
        after: createAuthMiddleware(async (ctx) => {
            if (ctx.path !== "/sign-up/email") return;
            const userId = ctx.context.newSession?.user.id;
            const token = ctx.headers?.get(INVITE_HEADER);
            if (!userId || !token) return;
            await db
                .update(schema.invite)
                .set({ usedAt: new Date(), usedBy: userId })
                .where(and(eq(schema.invite.token, token), isNull(schema.invite.usedAt)));
        }),
    },
    plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
export { userCount, validInvite };
