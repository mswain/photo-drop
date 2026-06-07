import { type NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import {
  objectExists,
  getObjectBytes,
  putObject,
  presignDownload,
} from "@/lib/s3";
import { thumbnailKey, isThumbnailKey, isManagedKey, isVideoKey } from "@/lib/ids";
import { generateThumbnail, UnsupportedImageError } from "@/lib/thumbnail";
import { env } from "@/lib/env";
import { handle, json, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/photos/thumbnail?key=<original-key>
//
// Returns a presigned URL for the original's thumbnail, generating it on demand
// (and caching it in S3 under "<slug>-thumbnails/<filename>") if it doesn't
// exist yet. No DB state: the thumbnail key is derived from the original key.
export const GET = handle(async (req: NextRequest) => {
  await requireSession();

  const root = env.s3KeyPrefix();
  const key = new URL(req.url).searchParams.get("key");

  if (!isManagedKey(key, root) || isThumbnailKey(key, root)) {
    return badRequest("A valid image key is required");
  }

  // Videos aren't image-thumbnailable (and could be large); the client shows a
  // placeholder for these and plays them via /api/admin/photos/play instead.
  if (isVideoKey(key)) {
    return json(
      { error: "Preview not available for videos." },
      { status: 422 },
    );
  }

  const thumbKey = thumbnailKey(key, root);
  if (!thumbKey) {
    return badRequest("Could not derive a thumbnail key");
  }

  // Generate only if missing.
  let generated = false;
  if (!(await objectExists(thumbKey))) {
    const original = await getObjectBytes(key);
    try {
      const { body, contentType } = await generateThumbnail(
        original,
        env.thumbnailMaxPx(),
      );
      await putObject(thumbKey, body, contentType);
      generated = true;
    } catch (err) {
      if (err instanceof UnsupportedImageError) {
        return json(
          { error: "Preview not available for this image format." },
          { status: 422 },
        );
      }
      throw err;
    }
  }

  // Inline (not attachment) so the browser renders it in the preview card.
  const url = await presignDownload(thumbKey, { download: false });
  return json({ url, generated });
});
