import sharp from "sharp";
import convert from "heic-convert";
import exifReader from "exif-reader";

/**
 * Image thumbnailing, isolated behind one function so the underlying libraries
 * can be swapped without touching route handlers.
 *
 * sharp (libvips) handles JPEG/PNG/WebP/AVIF/GIF/TIFF. HEIC/HEIF (common on
 * iPhones) is NOT decodable by sharp's prebuilt binaries, so we decode those to
 * JPEG with a WebAssembly libheif (heic-convert) first, then resize with sharp.
 */

export class UnsupportedImageError extends Error {
  constructor(message = "Unsupported image format") {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevm",
  "hevs",
  "heif",
  "mif1",
  "msf1",
]);

/** Detects HEIC/HEIF by the ISO-BMFF `ftyp` box brand. (AVIF is left to sharp.) */
function isHeif(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
  return HEIF_BRANDS.has(buf.toString("ascii", 8, 12).toLowerCase());
}

export interface ImageInfo {
  /** Pixel dimensions as displayed (EXIF orientation already applied). */
  width: number | null;
  height: number | null;
  /** Pixels per inch, when the file declares it. */
  density: number | null;
  format: string | null;
  colorSpace: string | null;
  hasAlpha: boolean;
  /**
   * EXIF capture time as a timezone-less "YYYY-MM-DDTHH:mm:ss" wall-clock
   * string — EXIF records the camera's local time with no zone, so this must
   * never be shifted into another timezone.
   */
  dateTaken: string | null;
}

const EXIF_MARKER = Buffer.from("Exif\0\0", "ascii");

/**
 * EXIF payload of a HEIC/HEIF file. heic-convert's decoded JPEG carries no
 * EXIF, so locate it in the original container instead. The Exif item's
 * payload starts at the "Exif\0\0" marker and the TIFF structure within is
 * self-limiting, so scanning for the marker beats parsing the ISO-BMFF box
 * tree to find the item's exact bounds.
 */
function heifExif(buf: Buffer): Buffer | undefined {
  const idx = buf.indexOf(EXIF_MARKER);
  return idx >= 0 ? buf.subarray(idx) : undefined;
}

/** EXIF capture time ("date taken"), or null if absent/unreadable. */
function exifDateTaken(exif: Buffer | undefined): string | null {
  if (!exif) return null;
  try {
    const tags = exifReader(exif);
    const date = tags.Photo?.DateTimeOriginal ?? tags.Image?.DateTime;
    if (!(date instanceof Date) || isNaN(date.getTime())) return null;
    // exif-reader assembles the Date via Date.UTC from the EXIF wall-clock
    // fields, so the UTC view of the Date *is* the original wall time.
    return date.toISOString().slice(0, 19);
  } catch {
    return null;
  }
}

/**
 * S3 user-metadata key under which a thumbnail carries its original's
 * ImageInfo, JSON-encoded. Its presence (even as "null", when extraction
 * failed) marks the thumbnail as info-bearing; older thumbnails without it are
 * regenerated once so the info gets backfilled.
 */
export const IMAGE_INFO_METADATA_KEY = "image-info";

/** Encodes ImageInfo for storage as S3 object metadata. */
export function encodeImageInfo(info: ImageInfo | null): Record<string, string> {
  return { [IMAGE_INFO_METADATA_KEY]: JSON.stringify(info) };
}

/**
 * Decodes ImageInfo from S3 object metadata. Returns the info, or null when
 * the marker is present but extraction had failed, or undefined when the
 * object predates info caching entirely.
 */
export function decodeImageInfo(
  metadata: Record<string, string>,
): ImageInfo | null | undefined {
  const raw = metadata[IMAGE_INFO_METADATA_KEY];
  if (raw === undefined) return undefined;
  try {
    const info = JSON.parse(raw) as ImageInfo | null;
    // Info cached before a field existed (e.g. dateTaken) is treated as absent
    // so the thumbnail regenerates once and the new field gets backfilled.
    if (info && !("dateTaken" in info)) return undefined;
    return info;
  } catch {
    return null;
  }
}

/**
 * Reads technical metadata (dimensions, DPI, format, …) from an image buffer.
 * HEIC/HEIF goes through the same WebAssembly decode as thumbnailing, since
 * sharp's prebuilt binaries can't read it; the decoded JPEG loses the original
 * density, so HEIC reports dimensions but no DPI.
 */
export async function extractImageInfo(input: Buffer): Promise<ImageInfo> {
  try {
    const heif = isHeif(input);
    let source = input;
    if (heif) {
      const decoded = await convert({ buffer: input, format: "JPEG", quality: 0.92 });
      source = Buffer.from(decoded);
    }

    const meta = await sharp(source, { failOn: "error" }).metadata();

    // EXIF orientations 5-8 are 90°/270° rotations: the stored width/height are
    // transposed relative to how the image displays, so swap them back.
    const transposed = (meta.orientation ?? 1) >= 5;
    return {
      width: (transposed ? meta.height : meta.width) ?? null,
      height: (transposed ? meta.width : meta.height) ?? null,
      density: heif ? null : meta.density ?? null,
      format: heif ? "heic" : meta.format ?? null,
      colorSpace: meta.space ?? null,
      hasAlpha: Boolean(meta.hasAlpha),
      dateTaken: exifDateTaken(heif ? heifExif(input) : meta.exif),
    };
  } catch (err) {
    throw new UnsupportedImageError(
      err instanceof Error ? err.message : "Unsupported image format",
    );
  }
}

/**
 * Resizes an image to fit within `maxPx` on its longest edge and re-encodes it
 * as JPEG (broad browser support — handles the common case where the original
 * is something a browser can't display inline). Never enlarges.
 */
export async function generateThumbnail(
  input: Buffer,
  maxPx: number,
): Promise<{ body: Buffer; contentType: string }> {
  try {
    let source = input;

    // Decode HEIC/HEIF to JPEG bytes first; sharp can't read it directly.
    if (isHeif(input)) {
      const decoded = await convert({
        buffer: input, // Buffer is a Uint8Array
        format: "JPEG",
        quality: 0.92,
      });
      source = Buffer.from(decoded);
    }

    const body = await sharp(source, { failOn: "error" })
      .rotate() // respect EXIF orientation
      .resize({
        width: maxPx,
        height: maxPx,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return { body, contentType: "image/jpeg" };
  } catch (err) {
    // Thrown for formats neither libheif nor libvips can decode.
    throw new UnsupportedImageError(
      err instanceof Error ? err.message : "Unsupported image format",
    );
  }
}
