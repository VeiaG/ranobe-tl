import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

/** For container healthchecks: up and able to reach the database. */
export async function GET() {
    try {
        await db.execute(sql`select 1`);
        return Response.json({ ok: true });
    } catch {
        return Response.json({ ok: false }, { status: 503 });
    }
}
