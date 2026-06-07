import { type NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { presignDownload } from "@/lib/s3";
import { isManagedKey, isThumbnailKey, videoContentType } from "@/lib/ids";
import { env } from "@/lib/env";
import { handle, json, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/photos/play?key=<video-key>
//
// Returns a short-lived presigned S3 URL for playing a video inline. Unlike the
// download route (always attachment), this serves the object inline so a
// <video> element can stream it directly from S3 — but it FORCES a known-safe
// `video/*` content-type derived from the key's extension. The stored
// content-type is attacker-controllable (the PUT content-type isn't signed), so
// forcing it means a non-video uploaded under a video key can never be served
// as something a browser would execute.
export const GET = handle(async (req: NextRequest) => {
  await requireSession();

  const root = env.s3KeyPrefix();
  const key = new URL(req.url).searchParams.get("key");

  if (!isManagedKey(key, root) || isThumbnailKey(key, root)) {
    return badRequest("A valid object key is required");
  }

  const contentType = videoContentType(key);
  if (!contentType) {
    return badRequest("This object is not a playable video");
  }

  const url = await presignDownload(key, { download: false, contentType });
  return json({ url });
});
