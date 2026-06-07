import { type NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { createUserSchema } from "@/lib/validation";
import { handle, json, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/users — list admin accounts (never returns password hashes).
export const GET = handle(async () => {
  await requireSession();
  const users = await db
    .select({
      id: admins.id,
      username: admins.username,
      createdAt: admins.createdAt,
    })
    .from(admins)
    .orderBy(asc(admins.username));
  return json({ users });
});

// POST /api/admin/users — create a new admin.
export const POST = handle(async (req: NextRequest) => {
  await requireSession();
  const body = await req.json().catch(() => null);
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Invalid username or password", parsed.error.flatten());
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  try {
    const [user] = await db
      .insert(admins)
      .values({ username: parsed.data.username, passwordHash })
      .returning({
        id: admins.id,
        username: admins.username,
        createdAt: admins.createdAt,
      });
    return json({ user }, { status: 201 });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      return json({ error: "That username is already taken." }, { status: 409 });
    }
    throw err;
  }
});
