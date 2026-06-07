import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { uploadLinks } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { updateLinkSchema } from "@/lib/validation";
import { handle, json, badRequest, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/links/:id — update label / expiry / cap / active state.
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireSession();
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  const parsed = updateLinkSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Invalid update payload", parsed.error.flatten());
  }

  const updates: Partial<typeof uploadLinks.$inferInsert> = {};
  const data = parsed.data;
  if ("label" in data) updates.label = data.label ?? null;
  if ("isActive" in data && data.isActive !== undefined)
    updates.isActive = data.isActive;
  if ("expiresAt" in data && data.expiresAt !== undefined)
    updates.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  if ("maxUploads" in data && data.maxUploads !== undefined)
    updates.maxUploads = data.maxUploads;

  if (Object.keys(updates).length === 0) {
    return badRequest("No fields to update");
  }

  const [link] = await db
    .update(uploadLinks)
    .set(updates)
    .where(eq(uploadLinks.id, id))
    .returning();

  if (!link) return notFound("Link not found");
  return json({ link });
});

// DELETE /api/admin/links/:id — destroy the share link config.
// Files already uploaded under this link remain in S3 (S3 is the source of
// truth); they can still be browsed/deleted from the Photos view.
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  await requireSession();
  const { id } = await ctx.params;

  const [deleted] = await db
    .delete(uploadLinks)
    .where(eq(uploadLinks.id, id))
    .returning({ id: uploadLinks.id });

  if (!deleted) return notFound("Link not found");
  return json({ ok: true });
});
