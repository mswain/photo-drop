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
