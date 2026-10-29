import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { pool?: pg.Pool; db?: DB };

export function databaseUrl(): string {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    return url;
}

function create(): DB {
    globalForDb.pool ??= new pg.Pool({ connectionString: databaseUrl(), max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
    return drizzle(globalForDb.pool, { schema });
}

/** Lazily connected so that importing modules at build time does not need a database. */
export const db: DB = new Proxy({} as DB, {
    get(_, prop) {
        globalForDb.db ??= create();
        const value = (globalForDb.db as any)[prop];
        return typeof value === "function" ? value.bind(globalForDb.db) : value;
    },
});

export { schema };
