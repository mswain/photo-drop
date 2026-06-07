import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { uploadLinks, folders } from "@/db/schema";
import { presignRequestSchema } from "@/lib/validation";
import { buildObjectKey } from "@/lib/ids";
import { presignUpload, countObjects } from "@/lib/s3";
import { env } from "@/lib/env";
import { handle, json, badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/**
 * POST /api/upload/:token/presign
 *
 * Public (no auth). Validates the share link, enforces the upload policy, and
 * returns one presigned S3 PUT URL per requested file. The browser then uploads
 * each file directly to S3 — traffic never flows through this app.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const { token } = await ctx.params;

  const [link] = await db
    .select({
      isActive: uploadLinks.isActive,
      expiresAt: uploadLinks.expiresAt,
      maxUploads: uploadLinks.maxUploads,
      slug: folders.slug,
    })
    .from(uploadLinks)
    .innerJoin(folders, eq(uploadLinks.folderId, folders.id))
    .where(eq(uploadLinks.token, token))
    .limit(1);

  if (!link) {
    return json({ error: "This upload link does not exist." }, { status: 404 });
  }
  if (!link.isActive) {
    return json(
      { error: "This upload link has been disabled." },
      { status: 403 },
    );
  }
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return json({ error: "This upload link has expired." }, { status: 410 });
  }

  const body = await req.json().catch(() => null);
  const parsed = presignRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Invalid upload request", parsed.error.flatten());
  }
  const { files } = parsed.data;

  // Per-file policy: images only (but not SVG, which can carry script), under
  // the size limit.
  const contentPrefix = env.allowedContentTypePrefix();
  const maxBytes = env.maxUploadBytes();
  for (const f of files) {
    const type = f.contentType.toLowerCase();
    if (!type.startsWith(contentPrefix)) {
      return badRequest(`Only ${contentPrefix}* files are allowed.`);
    }
    if (type === "image/svg+xml" || type === "image/svg") {
      return badRequest("SVG images are not allowed.");
    }
    if (f.size > maxBytes) {
      return badRequest(
        `Each file must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller.`,
      );
    }
  }

  // Files live under the link's human-readable slug directory.
  const prefix = `${env.s3KeyPrefix()}${link.slug}/`;

  // Enforce the optional upload cap by counting existing objects for this link.
  if (link.maxUploads != null) {
    const existing = await countObjects(prefix, link.maxUploads);
    if (existing + files.length > link.maxUploads) {
      return json(
        {
          error: `This link accepts at most ${link.maxUploads} photos and already has ${existing}.`,
        },
        { status: 409 },
      );
    }
  }

  const uploads = await Promise.all(
    files.map(async (f) => {
      const key = buildObjectKey({ prefix, contentType: f.contentType });
      const url = await presignUpload(key);
      return { key, url };
    }),
  );

  return json({ uploads, expiresIn: env.presignExpirySeconds() });
});
