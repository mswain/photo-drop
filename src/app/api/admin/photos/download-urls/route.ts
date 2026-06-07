import { type NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { presignDownload } from "@/lib/s3";
import { isManagedKey } from "@/lib/ids";
import { downloadUrlsSchema } from "@/lib/validation";
import { env } from "@/lib/env";
import { handle, json, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/photos/download-urls  { keys: string[] }
//
// Returns one presigned S3 GET URL (attachment) per key so the browser can
// download multiple selected photos directly from S3 — the file bytes never
// flow through the app, only these short-lived signed URLs.
export const POST = handle(async (req: NextRequest) => {
  await requireSession();

  const body = await req.json().catch(() => null);
  const parsed = downloadUrlsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Invalid request", parsed.error.flatten());
  }

  const root = env.s3KeyPrefix();
  const keys = parsed.data.keys.filter((k) => isManagedKey(k, root));
  if (keys.length === 0) {
    return badRequest("No valid object keys");
  }

  const urls = await Promise.all(
    keys.map(async (key) => ({
      key,
      url: await presignDownload(key, { download: true }),
    })),
  );

  return json({ urls });
});
