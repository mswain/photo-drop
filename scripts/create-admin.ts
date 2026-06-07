import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { admins } from "../src/db/schema";

/**
 * Creates (or updates the password of) an admin account.
 *
 * Usage:
 *   pnpm run create-admin <username> <password>
 *   ADMIN_USERNAME=alice ADMIN_PASSWORD=secret pnpm run create-admin
 *   pnpm run create-admin            # interactive prompt
 */
async function prompt(): Promise<{ username: string; password: string }> {
  const args = process.argv.slice(2);
  let username = args[0] ?? process.env.ADMIN_USERNAME ?? "";
  let password = args[1] ?? process.env.ADMIN_PASSWORD ?? "";

  if (!username || !password) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      if (!username) username = (await rl.question("Admin username: ")).trim();
      if (!password) password = await rl.question("Admin password: ");
    } finally {
      rl.close();
    }
  }

  if (!username || !password) {
    throw new Error("Both username and password are required");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  return { username, password };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const { username, password } = await prompt();
  const passwordHash = await bcrypt.hash(password, 12);

  const sql = postgres(url, { max: 1 });
  try {
    const db = drizzle(sql, { schema: { admins } });
    const existing = await db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.username, username));

    if (existing.length > 0) {
      await db
        .update(admins)
        .set({ passwordHash })
        .where(eq(admins.username, username));
      console.log(`Updated password for existing admin "${username}".`);
    } else {
      await db.insert(admins).values({ username, passwordHash });
      console.log(`Created admin "${username}".`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Failed to create admin:", err.message ?? err);
  process.exit(1);
});
