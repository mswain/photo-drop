import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { uploadLinks } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { newLinkToken } from "@/lib/ids";
import { handle, json, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/links/:id/regenerate — issue a fresh token, invalidating the
// old share URL. Uploads continue to land in the same folder.
export const POST = handle(async (_req: NextRequest, ctx: Ctx) => {
  await requireSession();
  const { id } = await ctx.params;

  const [link] = await db
    .update(uploadLinks)
    .set({ token: newLinkToken() })
    .where(eq(uploadLinks.id, id))
    .returning();

  if (!link) return notFound("Link not found");
  return json({ link });
});
