import sharp from "sharp";
import convert from "heic-convert";

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
    return JSON.parse(raw) as ImageInfo | null;
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
