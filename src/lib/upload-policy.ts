import { env } from "./env";

/**
 * Validates a self-reported content-type against the media policy shared by
 * every upload path: only the allowed prefixes (images/videos by default), and
 * never SVG (which can carry script). Returns a human error message, or null
 * when the type is allowed. Per-file size caps are enforced separately — admins
 * bypass them, public links don't.
 */
export function contentTypeError(contentType: string): string | null {
  const type = contentType.toLowerCase();
  const prefixes = env.allowedContentTypePrefixes();
  if (!prefixes.some((p) => type.startsWith(p))) {
    return `Only ${prefixes.map((p) => `${p}*`).join(" or ")} files are allowed.`;
  }
  if (type === "image/svg+xml" || type === "image/svg") {
    return "SVG images are not allowed.";
  }
  return null;
}
