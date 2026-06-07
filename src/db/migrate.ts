import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Applies all generated SQL migrations in ./drizzle. Run on container startup
 * (see docker-entrypoint.sh) and via `pnpm db:migrate` locally.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const sql = postgres(url, { max: 1 });
  try {
    const db = drizzle(sql);
    console.log("Applying migrations…");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
