import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

// Reuse a single connection pool across hot-reloads in development and across
// the module graph in production. We intentionally do not throw at import time
// when DATABASE_URL is missing — the connection is established lazily on the
// first query, which keeps `next build` from failing in environments where the
// database is not reachable during the build.
const connectionString = process.env.DATABASE_URL ?? "";

const globalForDb = globalThis as unknown as {
  _pgClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb._pgClient ??
  postgres(connectionString, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // postgres-js fails fast instead of buffering queries forever when the DB
    // is unreachable.
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb._pgClient = client;
}

export const db = drizzle(client, { schema });
export { schema };
