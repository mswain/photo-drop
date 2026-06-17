import { randomBytes } from "crypto";

/**
 * Maps common image content-types to file extensions. Used only to give the
 * object key a sensible suffix so downloads land with a usable filename. We
 * never read or store the uploader's original filename.
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
  // Video
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/x-m4v": "m4v",
  "video/x-msvideo": "avi",
  "video/x-matroska": "mkv",
  "video/3gpp": "3gp",
  "video/mpeg": "mpeg",
};

/**
 * File extension -> content-type to FORCE when serving a video back for inline
 * playback. We never trust the stored content-type (the PUT content-type is
 * unsigned, so it's attacker-controllable); forcing it from the GUID key's
 * extension means a malicious "video" can only ever be served as a video, not
 * rendered as script. A key whose extension isn't here is not a video.
 *
 * These are tuned for the HTML <video> element, which is stricter than the
 * browser's standalone media viewer: it refuses to play a source whose MIME
 * type it doesn't whitelist, even when it could decode the bytes. The big one
 * is QuickTime — Chrome/Firefox reject "video/quicktime" outright, but most
 * .mov / .m4v files from phones are H.264/AAC in an MP4-family container and
 * play fine when labeled "video/mp4". So we relabel those to the web-friendly
 * type rather than their pedantically-correct one.
 */
const VIDEO_EXT_CONTENT_TYPE: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  "3gp": "video/3gpp",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
};

/** Lowercased file extension of a key (no dot), or "". */
function extOf(key: string): string {
  const name = key.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True if the object key names a video (by its extension). */
export function isVideoKey(key: string): boolean {
  return extOf(key) in VIDEO_EXT_CONTENT_TYPE;
}

/**
 * The content-type to force when serving a video key inline, derived solely
 * from its extension. Returns null for non-video keys.
 */
export function videoContentType(key: string): string | null {
  return VIDEO_EXT_CONTENT_TYPE[extOf(key)] ?? null;
}

/** A short, URL-safe, unguessable token for public share links. */
export function newLinkToken(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Crockford Base32 alphabet, in ascending value order — so the lexicographic
 * order of encoded strings matches the numeric order of what they encode.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// Ceiling of a 48-bit millisecond timestamp. We store `MAX_TIME - now` so that
// a LATER time encodes to a LEXICOGRAPHICALLY SMALLER string.
const MAX_TIME = 2 ** 48 - 1;

/** Encodes a non-negative integer as `len` big-endian Crockford Base32 chars. */
function encodeBase32(value: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/**
 * A 26-char, ULID-shaped id whose keys sort NEWEST-FIRST in plain lexicographic
 * order. A normal ULID sorts oldest-first (its leading 48-bit timestamp ascends
 * with time); we encode `MAX_TIME - now` instead, so a later upload yields a
 * smaller string. The trailing 80 bits are random for uniqueness within a
 * millisecond. This lets S3's key-ordered listing return the most recent
 * uploads first with no in-app sorting.
 */
export function newSortableId(): string {
  const time = encodeBase32(MAX_TIME - Date.now(), 10);
  const rand = randomBytes(16);
  let suffix = "";
  // 256 % 32 === 0, so `byte % 32` is an unbiased Base32 digit.
  for (let i = 0; i < rand.length; i++) suffix += CROCKFORD[rand[i] % 32];
  return time + suffix;
}

/**
 * Builds an S3 object key under the given directory prefix. The filename is a
 * time-sortable id (see `newSortableId` — newest sorts first); an extension is
 * appended (derived from the content-type) purely so downloads and content-type
 * sniffing behave sensibly.
 *
 * `prefix` is the link's full directory and must end with "/"
 * (e.g. "jims-wedding/" or "uploads/jims-wedding/").
 */
export function buildObjectKey(params: {
  prefix: string;
  contentType?: string | null;
}): string {
  const id = newSortableId();
  const ext = params.contentType
    ? CONTENT_TYPE_EXT[params.contentType.toLowerCase()]
    : undefined;
  const name = ext ? `${id}.${ext}` : id;
  return `${params.prefix}${name}`;
}

/**
 * True for a client-supplied object key that's safe to act on: a non-empty key
 * under the configured root, living inside a folder, with no path-traversal
 * segments. Narrows `string | null` so callers can drop a separate null check.
 */
export function isManagedKey(
  key: string | null | undefined,
  rootPrefix: string,
): key is string {
  return (
    typeof key === "string" &&
    key.length > rootPrefix.length &&
    key.startsWith(rootPrefix) &&
    key.includes("/") &&
    !key.includes("..")
  );
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
