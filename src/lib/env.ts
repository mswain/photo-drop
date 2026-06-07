/**
 * Centralized, lazily-read environment access. Getters throw only when a
 * required value is actually needed at runtime (not at import/build time).
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  databaseUrl: () => required("DATABASE_URL"),
  sessionSecret: () => required("SESSION_SECRET"),

  // S3 / AWS
  s3Bucket: () => required("S3_BUCKET"),
  awsRegion: () => process.env.AWS_REGION ?? "us-east-1",
  s3Endpoint: () => process.env.S3_ENDPOINT || undefined,
  s3ForcePathStyle: () => process.env.S3_FORCE_PATH_STYLE === "true",

  /**
   * Optional namespace prepended to every object key. Default "" puts each
   * link's slug directly under the bucket root (e.g. "jims-wedding/<guid>").
   * Set e.g. "uploads/" to scope all app objects under one prefix. Always
   * normalized to have no leading slash and a single trailing slash (or empty).
   */
  s3KeyPrefix: () => {
    const raw = (process.env.S3_KEY_PREFIX ?? "").trim();
    if (!raw) return "";
    return raw.replace(/^\/+/, "").replace(/\/*$/, "/");
  },

  // Upload policy
  maxUploadBytes: () => intEnv("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  allowedContentTypePrefix: () =>
    process.env.ALLOWED_CONTENT_TYPE_PREFIX ?? "image/",
  presignExpirySeconds: () => intEnv("PRESIGN_EXPIRY_SECONDS", 900),

  // Largest batch of files accepted by a single presign request.
  maxBatchSize: () => intEnv("MAX_BATCH_SIZE", 100),

  // Longest edge (px) of generated preview thumbnails.
  thumbnailMaxPx: () => intEnv("THUMBNAIL_MAX_PX", 600),
};
