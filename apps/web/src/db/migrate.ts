import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Applies pending migrations; an advisory lock keeps the web and worker containers from racing. */
export async function runMigrations(folder = process.env.MIGRATIONS_DIR ?? path.resolve("drizzle")): Promise<void> {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        await client.query("SELECT pg_advisory_lock(726354)");
        await migrate(drizzle(client), { migrationsFolder: folder });
    } finally {
        await client.query("SELECT pg_advisory_unlock(726354)").catch(() => {});
        await client.end();
    }
}

const isMain = process.argv[1] && /migrate\.(ts|js|mjs)$/.test(process.argv[1]);
if (isMain) {
    runMigrations()
        .then(() => console.log("migrations applied"))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
