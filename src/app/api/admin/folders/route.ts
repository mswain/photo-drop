import { type NextRequest } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { folders, uploadLinks } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { createFolderSchema } from "@/lib/validation";
import { slugify } from "@/lib/slug";
import { newLinkToken } from "@/lib/ids";
import { handle, json, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Finds an unused folder slug, appending -2, -3, … on collision. */
async function uniqueSlug(base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const existing = await db
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.slug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
}

// GET /api/admin/folders — all folders with their link counts.
export const GET = handle(async () => {
  await requireSession();
  const rows = await db
    .select({
      id: folders.id,
      slug: folders.slug,
      label: folders.label,
      createdAt: folders.createdAt,
      linkCount: sql<number>`count(${uploadLinks.id})::int`,
    })
    .from(folders)
    .leftJoin(uploadLinks, eq(uploadLinks.folderId, folders.id))
    .groupBy(folders.id)
    .orderBy(desc(folders.createdAt));
  return json({ folders: rows });
});

// POST /api/admin/folders — create a folder (with one initial share link).
export const POST = handle(async (req: NextRequest) => {
  const session = await requireSession();
  const body = await req.json().catch(() => null);
  const parsed = createFolderSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("A folder name is required", parsed.error.flatten());
  }

  const slug = await uniqueSlug(slugify(parsed.data.label));

  const [folder] = await db
    .insert(folders)
    .values({ slug, label: parsed.data.label, createdBy: session.sub })
    .returning();

  const [link] = await db
    .insert(uploadLinks)
    .values({ token: newLinkToken(), folderId: folder.id, createdBy: session.sub })
    .returning();

  return json({ folder, link }, { status: 201 });
});
