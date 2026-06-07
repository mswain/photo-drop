/**
 * Turns a human label into a filesystem/S3-safe slug used as the upload
 * directory for a link. e.g. "Jim's Wedding!" -> "jims-wedding".
 */
export function slugify(label: string | null | undefined): string {
  const base = (label ?? "")
    .normalize("NFKD")
    // strip combining accent marks (U+0300–U+036F)
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // drop apostrophes entirely so "jim's" -> "jims" (not "jim-s")
    .replace(/['’`]/g, "")
    // any run of non-alphanumerics becomes a single dash
    .replace(/[^a-z0-9]+/g, "-")
    // trim and collapse dashes
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    // keep keys reasonably short
    .slice(0, 60)
    .replace(/-+$/g, "");

  return base || "untitled";
}
