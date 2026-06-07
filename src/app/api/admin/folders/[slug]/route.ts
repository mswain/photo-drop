import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { handle, json, notFound } from "@/lib/http";
import { movePrefix } from "@/lib/s3";
import { env } from "@/lib/env";
import { THUMBNAIL_DIR_SUFFIX } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * Sentinel directory (under the configured root) where soft-deleted folders are
 * parked. A real slug can never be "_deleted": slugify() collapses every
 * non-alphanumeric run to a dash and trims leading dashes, so the underscore
 * could never survive — the sentinel can't collide with a live folder.
 */
const ARCHIVE_DIR = "_deleted";

// DELETE /api/admin/folders/:slug — soft-delete a folder. The DB record and its
// links (cascade) are removed, and the folder's S3 objects — originals plus the
// sibling thumbnails directory — are RELOCATED under "<root>_deleted/…" rather
// than erased. Nothing is listed at the old slug, but the bytes are preserved
// and recoverable. The destination is timestamped so re-creating and deleting
// the same slug never overwrites an earlier archive.
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  await requireSession();
  const { slug } = await ctx.params;

  const [deleted] = await db
    .delete(folders)
    .where(eq(folders.slug, slug))
    .returning({ id: folders.id });

  // S3 is the source of truth for files, so a slug can have objects with no DB
  // row (e.g. an unregistered folder). Archive the objects regardless.
  const root = env.s3KeyPrefix();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveBase = `${root}${ARCHIVE_DIR}/${slug}-${stamp}`;

  let moved = 0;
  moved += await movePrefix(`${root}${slug}/`, `${archiveBase}/`);
  moved += await movePrefix(
    `${root}${slug}${THUMBNAIL_DIR_SUFFIX}/`,
    `${archiveBase}${THUMBNAIL_DIR_SUFFIX}/`,
  );

  if (!deleted && moved === 0) return notFound("Folder not found");
  return json({ ok: true, archived: moved });
});
