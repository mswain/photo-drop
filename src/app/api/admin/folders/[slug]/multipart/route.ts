import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { multipartSchema } from "@/lib/validation";
import { buildObjectKey, isManagedKey, slugFromKey } from "@/lib/ids";
import {
  createMultipartUpload,
  presignUploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
} from "@/lib/s3";
import { contentTypeError } from "@/lib/upload-policy";
import { env } from "@/lib/env";
import { handle, json, badRequest, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// 100 MiB parts keep the part count (and the number of presigned URLs) low for
// typical files; the size is bumped only if a file is big enough to exceed
// S3's 10,000-part limit at that size.
const PART_SIZE = 100 * 1024 * 1024;
const MAX_PARTS = 10_000;
// S3's maximum object size (5 TiB) — the effective ceiling for an admin upload.
const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024 * 1024;
// Part URLs are signed up front but the transfer can run for hours, so give
// them a generous (but well under SigV4's 7-day max) lifetime.
const PART_URL_EXPIRY_SECONDS = 24 * 60 * 60;

/** Chooses a part size so the file splits into at most MAX_PARTS parts. */
function partSizeFor(size: number): number {
  if (Math.ceil(size / PART_SIZE) <= MAX_PARTS) return PART_SIZE;
  const needed = Math.ceil(size / MAX_PARTS);
  // Round up to a whole MiB for tidiness.
  return Math.ceil(needed / (1024 * 1024)) * (1024 * 1024);
}

/**
 * POST /api/admin/folders/:slug/multipart
 *
 * Admin-only multipart upload control plane for files larger than the 5 GiB
 * single-PUT limit. One endpoint, three ops:
 *   - create:   start an upload, returns the key, upload id, and a presigned
 *               PUT URL per part.
 *   - complete: finalize the object from the parts' ETags.
 *   - abort:    discard a failed/cancelled upload so no parts linger (billed).
 * The slug comes from the folder record, and complete/abort verify the key
 * lives under that folder — a client can't touch another folder's upload.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireSession();
  const { slug } = await ctx.params;

  const [folder] = await db
    .select({ slug: folders.slug })
    .from(folders)
    .where(eq(folders.slug, slug))
    .limit(1);
  if (!folder) return notFound("Folder not found");

  const body = await req.json().catch(() => null);
  const parsed = multipartSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Invalid multipart request", parsed.error.flatten());
  }
  const msg = parsed.data;
  const root = env.s3KeyPrefix();

  if (msg.op === "create") {
    const typeError = contentTypeError(msg.contentType);
    if (typeError) return badRequest(typeError);
    if (msg.size > MAX_OBJECT_BYTES) {
      return badRequest("Each file must be 5 TB or smaller.");
    }

    const key = buildObjectKey({
      prefix: `${root}${folder.slug}/`,
      contentType: msg.contentType,
    });
    const uploadId = await createMultipartUpload(key, msg.contentType);

    const partSize = partSizeFor(msg.size);
    const partCount = Math.ceil(msg.size / partSize);
    const urls = await Promise.all(
      Array.from({ length: partCount }, (_, i) => i + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await presignUploadPart({
            key,
            uploadId,
            partNumber,
            expiresIn: PART_URL_EXPIRY_SECONDS,
          }),
        }),
      ),
    );

    return json({ key, uploadId, partSize, urls });
  }

  // complete / abort: the key must be a real object key inside this folder.
  if (!isManagedKey(msg.key, root) || slugFromKey(msg.key, root) !== folder.slug) {
    return badRequest("Object key does not belong to this folder");
  }

  if (msg.op === "complete") {
    await completeMultipartUpload(msg.key, msg.uploadId, msg.parts);
    return json({ ok: true, key: msg.key });
  }

  await abortMultipartUpload(msg.key, msg.uploadId);
  return json({ ok: true });
});
