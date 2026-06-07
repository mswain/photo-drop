import { type NextRequest } from "next/server";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { photosQuerySchema } from "@/lib/validation";
import { listObjects, deleteObject } from "@/lib/s3";
import { slugFromKey, thumbnailKey } from "@/lib/ids";
import { env } from "@/lib/env";
import { handle, json, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A key is manageable if it lives under the configured root and is well-formed. */
function isManagedKey(key: string, root: string): boolean {
  return (
    key.length > root.length &&
    key.startsWith(root) &&
    key.includes("/") &&
    !key.includes("..")
  );
}

// GET /api/admin/photos — paginated listing of uploaded objects from S3.
// S3 paginates with continuation tokens, so the client pages via `cursor`.
export const GET = handle(async (req: NextRequest) => {
  await requireSession();

  const url = new URL(req.url);
  const parsed = photosQuerySchema.safeParse({
    slug: url.searchParams.get("slug") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  if (!parsed.success) {
    return badRequest("Invalid query", parsed.error.flatten());
  }
  const { slug, cursor, pageSize } = parsed.data;

  const root = env.s3KeyPrefix();
  const prefix = slug ? `${root}${slug}/` : root;

  const result = await listObjects({ prefix, maxKeys: pageSize, cursor });

  // Map folder slugs -> labels so the UI can show a friendly source name.
  const folderRows = await db
    .select({ slug: folders.slug, label: folders.label })
    .from(folders);
  const labelBySlug = new Map(folderRows.map((f) => [f.slug, f.label]));

  const items = result.objects.map((o) => {
    const linkSlug = slugFromKey(o.key, root);
    return {
      key: o.key,
      filename: o.key.split("/").pop() ?? o.key,
      size: o.size,
      lastModified: o.lastModified,
      linkSlug,
      linkLabel: linkSlug ? labelBySlug.get(linkSlug) ?? null : null,
      downloadUrl: `/api/admin/photos/download?key=${encodeURIComponent(o.key)}`,
    };
  });

  return json({
    items,
    nextCursor: result.nextCursor,
    isTruncated: result.isTruncated,
    pageSize,
  });
});

// DELETE /api/admin/photos?key=... — remove a single object (and its
// thumbnail, best-effort) from S3.
export const DELETE = handle(async (req: NextRequest) => {
  await requireSession();
  const root = env.s3KeyPrefix();
  const key = new URL(req.url).searchParams.get("key");
  if (!key || !isManagedKey(key, root)) {
    return badRequest("A valid object key is required");
  }
  await deleteObject(key);

  const thumbKey = thumbnailKey(key, root);
  if (thumbKey) {
    await deleteObject(thumbKey).catch(() => {
      /* thumbnail may not have been generated yet */
    });
  }
  return json({ ok: true });
});
