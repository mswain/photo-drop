import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { presignRequestSchema } from "@/lib/validation";
import { buildObjectKey } from "@/lib/ids";
import { presignUpload } from "@/lib/s3";
import { contentTypeError } from "@/lib/upload-policy";
import { env } from "@/lib/env";
import { handle, json, badRequest, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * S3 rejects a single PUT larger than 5 GiB — bigger objects require multipart
 * upload, which a presigned single-PUT URL can't express. This is a storage
 * limit, not an app policy, so we surface it even on the admin path.
 */
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * POST /api/admin/folders/:slug/presign
 *
 * Admin-only counterpart to the public upload presign. An authenticated admin
 * uploads straight into a folder, so the per-file size cap and the per-link
 * upload count cap do NOT apply — admins may upload files of arbitrary size (up
 * to S3's single-PUT ceiling). The media-type allowlist still applies (no SVG,
 * images/videos only) since downstream features assume that. The slug is taken
 * from the folder record, never the client, so it can't escape the folder.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireSession();
  const { slug } = await ctx.params;

  // Resolve the folder so the upload prefix comes from a trusted, registered
  // slug — uploads into an unregistered (orphaned) slug aren't allowed.
  const [folder] = await db
    .select({ slug: folders.slug })
    .from(folders)
    .where(eq(folders.slug, slug))
    .limit(1);
  if (!folder) {
    return notFound("Folder not found");
  }

  const body = await req.json().catch(() => null);
  const parsed = presignRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Invalid upload request", parsed.error.flatten());
  }
  const { files } = parsed.data;

  // Per-file policy: allowed media types only (but not SVG, which can carry
  // script). No per-file size cap — only S3's hard single-PUT ceiling. Files
  // above that go through the multipart route instead.
  for (const f of files) {
    const typeError = contentTypeError(f.contentType);
    if (typeError) return badRequest(typeError);
    if (f.size > MAX_SINGLE_PUT_BYTES) {
      return badRequest(
        "This file is too large for a single upload — use multipart upload.",
      );
    }
  }

  const prefix = `${env.s3KeyPrefix()}${folder.slug}/`;

  const uploads = await Promise.all(
    files.map(async (f) => {
      const key = buildObjectKey({ prefix, contentType: f.contentType });
      const url = await presignUpload(key, f.size);
      return { key, url };
    }),
  );

  return json({ uploads, expiresIn: env.presignExpirySeconds() });
});
