import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { handle, json, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// DELETE /api/admin/folders/:slug — remove the folder and its links. Photos
// already uploaded remain in S3 (S3 is the source of truth) and would only
// reappear if a folder with the same slug is recreated.
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  await requireSession();
  const { slug } = await ctx.params;

  const [deleted] = await db
    .delete(folders)
    .where(eq(folders.slug, slug))
    .returning({ id: folders.id });

  if (!deleted) return notFound("Folder not found");
  return json({ ok: true });
});
