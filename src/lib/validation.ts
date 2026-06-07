import { z } from "zod";
import { env } from "./env";

export const loginSchema = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
});

/**
 * Coerces an empty string / null to undefined so optional admin form fields can
 * be submitted blank.
 */
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), schema.optional());

export const createFolderSchema = z.object({
  label: z.string().min(1).max(255),
});

export const createLinkSchema = z.object({
  label: emptyToUndefined(z.string().max(255)),
  // ISO date-time string; converted to Date in the route.
  expiresAt: emptyToUndefined(z.string().datetime({ offset: true })),
  maxUploads: emptyToUndefined(z.coerce.number().int().positive().max(1_000_000)),
  isActive: z.boolean().optional(),
});

export const createUserSchema = z.object({
  username: z.string().min(3).max(255).regex(/^\S+$/, "No spaces allowed"),
  password: z.string().min(8).max(1024),
});

export const updateLinkSchema = z.object({
  label: emptyToUndefined(z.string().max(255)),
  expiresAt: z.preprocess(
    (v) => (v === "" ? null : v),
    z.union([z.string().datetime({ offset: true }), z.null()]).optional(),
  ),
  maxUploads: z.preprocess(
    (v) => (v === "" ? null : v),
    z.union([z.coerce.number().int().positive().max(1_000_000), z.null()]).optional(),
  ),
  isActive: z.boolean().optional(),
});

/**
 * A presign request describes the batch of files the browser wants to upload.
 * We only need the content-type (to validate it's an image and pick a key
 * extension) and size (to enforce the per-file limit). No filenames.
 */
export const presignRequestSchema = z.object({
  files: z
    .array(
      z.object({
        contentType: z.string().min(1).max(255),
        size: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(env.maxBatchSize()),
});

export const photosQuerySchema = z.object({
  slug: emptyToUndefined(z.string().max(255)),
  cursor: emptyToUndefined(z.string().max(4096)),
  pageSize: z.coerce.number().int().min(1).max(1000).default(50),
});

export const downloadUrlsSchema = z.object({
  keys: z.array(z.string().min(1).max(2048)).min(1).max(500),
});
