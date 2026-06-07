import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { presignDownload } from "@/lib/s3";
import { env } from "@/lib/env";
import { handle, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/photos/download?key=...
//
// Redirects to a short-lived presigned S3 GET URL so the file is served
// directly from S3, never proxied through the app. Originals are always served
// as an **attachment** (never inline) — a malicious uploaded content-type can't
// render as script. Inline preview is the re-encoded thumbnail (safe).
export const GET = handle(async (req: NextRequest) => {
  await requireSession();
  const key = new URL(req.url).searchParams.get("key");
  const root = env.s3KeyPrefix();
  if (!key || key.length <= root.length || !key.startsWith(root) || key.includes("..")) {
    return badRequest("A valid object key is required");
  }
  const url = await presignDownload(key, { download: true });
  return NextResponse.redirect(url);
});
