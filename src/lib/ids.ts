import { randomUUID, randomBytes } from "crypto";

/**
 * Maps common image content-types to file extensions. Used only to give the
 * GUID object key a sensible suffix so downloads land with a usable filename.
 * We never read or store the uploader's original filename.
 */
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
};

/** A short, URL-safe, unguessable token for public share links. */
export function newLinkToken(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Builds a GUID-based S3 object key under the given directory prefix. The
 * stored filename is always a GUID; an extension is appended (derived from the
 * content-type) purely so downloads and content-type sniffing behave sensibly.
 *
 * `prefix` is the link's full directory and must end with "/"
 * (e.g. "jims-wedding/" or "uploads/jims-wedding/").
 */
export function buildObjectKey(params: {
  prefix: string;
  contentType?: string | null;
}): string {
  const guid = randomUUID();
  const ext = params.contentType
    ? CONTENT_TYPE_EXT[params.contentType.toLowerCase()]
    : undefined;
  const name = ext ? `${guid}.${ext}` : guid;
  return `${params.prefix}${name}`;
}

/** Suffix appended to a slug to form its sibling thumbnails directory. */
export const THUMBNAIL_DIR_SUFFIX = "-thumbnails";

/**
 * Given an object key and the configured root prefix, returns the link's slug
 * (the single directory segment between the root and the filename), or null.
 *   key="jims-wedding/<guid>.png", root=""        -> "jims-wedding"
 *   key="uploads/jims-wedding/<guid>.png", root="uploads/" -> "jims-wedding"
 */
export function slugFromKey(key: string, rootPrefix: string): string | null {
  if (rootPrefix && !key.startsWith(rootPrefix)) return null;
  const rest = key.slice(rootPrefix.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/** True if the key lives in a "<slug>-thumbnails/" directory. */
export function isThumbnailKey(key: string, rootPrefix: string): boolean {
  const dir = slugFromKey(key, rootPrefix);
  return dir != null && dir.endsWith(THUMBNAIL_DIR_SUFFIX);
}

/**
 * Deterministically maps an original object key to its thumbnail key, which
 * lives in a sibling "<slug>-thumbnails/" directory with the SAME filename so
 * we never have to track which thumbnails exist.
 *   "jims-wedding/<guid>.jpg" -> "jims-wedding-thumbnails/<guid>.jpg"
 */
export function thumbnailKey(
  originalKey: string,
  rootPrefix: string,
): string | null {
  const slug = slugFromKey(originalKey, rootPrefix);
  const filename = originalKey.split("/").pop();
  if (!slug || !filename || slug.endsWith(THUMBNAIL_DIR_SUFFIX)) return null;
  return `${rootPrefix}${slug}${THUMBNAIL_DIR_SUFFIX}/${filename}`;
}
