import { type NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import {
  headObjectMetadata,
  getObjectBytes,
  putObject,
  presignDownload,
} from "@/lib/s3";
import { thumbnailKey, isThumbnailKey, isManagedKey, isVideoKey } from "@/lib/ids";
import {
  generateThumbnail,
  extractImageInfo,
  encodeImageInfo,
  decodeImageInfo,
  UnsupportedImageError,
  type ImageInfo,
} from "@/lib/thumbnail";
import { env } from "@/lib/env";
import { handle, json, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/photos/thumbnail?key=<original-key>
//
// Returns a presigned URL for the original's thumbnail plus the original's
// technical metadata (dimensions, DPI, …), generating the thumbnail on demand
// (and caching it in S3 under "<slug>-thumbnails/<filename>") if it doesn't
// exist yet. The metadata is extracted while the original bytes are in hand
// during generation and cached as S3 user metadata on the thumbnail object, so
// serving a cached thumbnail never re-downloads the (possibly large) original.
// No DB state: the thumbnail key is derived from the original key.
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

  // One HEAD answers "does the thumbnail exist?" and hands back any cached
  // info. A thumbnail from before info caching (no marker) is regenerated once
  // so its info gets backfilled.
  const existing = await headObjectMetadata(thumbKey);
  let info: ImageInfo | null | undefined =
    existing ? decodeImageInfo(existing) : undefined;

  let generated = false;
  if (info === undefined) {
    const original = await getObjectBytes(key);
    try {
      // Extraction failure is non-fatal (info stays null) — the cached "null"
      // marker keeps us from re-fetching the original on every request.
      info = await extractImageInfo(original).catch(() => null);
      const { body, contentType } = await generateThumbnail(
        original,
        env.thumbnailMaxPx(),
      );
      await putObject(thumbKey, body, contentType, encodeImageInfo(info));
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
  return json({ url, generated, info });
});
