import { type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { handle, json, badRequest, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/admin/users/:id — remove an admin. You can't delete yourself or
// the last remaining admin (which would lock everyone out).
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const session = await requireSession();
  const { id } = await ctx.params;

  if (id === session.sub) {
    return badRequest("You can't delete your own account.");
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(admins);
  if (count <= 1) {
    return badRequest("Can't delete the last admin.");
  }

  const [deleted] = await db
    .delete(admins)
    .where(eq(admins.id, id))
    .returning({ id: admins.id });

  if (!deleted) return notFound("Admin not found");
  return json({ ok: true });
});
