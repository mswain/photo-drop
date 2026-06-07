import { type NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { folders, uploadLinks } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { createLinkSchema } from "@/lib/validation";
import { newLinkToken } from "@/lib/ids";
import { handle, json, badRequest, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

async function folderBySlug(slug: string) {
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.slug, slug))
    .limit(1);
  return folder ?? null;
}

// GET /api/admin/folders/:slug/links — links belonging to the folder.
export const GET = handle(async (_req: NextRequest, ctx: Ctx) => {
  await requireSession();
  const { slug } = await ctx.params;
  const folder = await folderBySlug(slug);
  if (!folder) return notFound("Folder not found");

  const links = await db
    .select()
    .from(uploadLinks)
    .where(eq(uploadLinks.folderId, folder.id))
    .orderBy(desc(uploadLinks.createdAt));
  return json({ links });
});

// POST /api/admin/folders/:slug/links — add a new share link to the folder.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const session = await requireSession();
  const { slug } = await ctx.params;
  const folder = await folderBySlug(slug);
  if (!folder) return notFound("Folder not found");

  const body = await req.json().catch(() => null);
  const parsed = createLinkSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Invalid link settings", parsed.error.flatten());
  }
  const { label, expiresAt, maxUploads, isActive } = parsed.data;

  const [link] = await db
    .insert(uploadLinks)
    .values({
      token: newLinkToken(),
      folderId: folder.id,
      label: label ?? null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      maxUploads: maxUploads ?? null,
      isActive: isActive ?? true,
      createdBy: session.sub,
    })
    .returning();

  return json({ link }, { status: 201 });
});
