import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

let _client: S3Client | null = null;

/**
 * Lazily-constructed S3 client. Credentials are taken from the standard
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables via the SDK's
 * default credential provider chain.
 */
export function s3(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: env.awsRegion(),
      endpoint: env.s3Endpoint(),
      forcePathStyle: env.s3ForcePathStyle(),
    });
  }
  return _client;
}

/**
 * Presigned PUT URL for a direct browser-to-S3 upload. We don't sign the
 * Content-Type (avoids brittle exact-match SignatureDoesNotMatch failures);
 * uploaded originals are only ever served back as attachments, never inline,
 * so a malicious stored content-type can't render as script. See
 * `presignDownload` (always attachment) and the SVG block in the presign route.
 */
export async function presignUpload(key: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: env.s3Bucket(),
    Key: key,
  });
  return getSignedUrl(s3(), command, {
    expiresIn: env.presignExpirySeconds(),
  });
}

/** Presigned GET URL for downloading an object (optionally forcing download). */
export async function presignDownload(
  key: string,
  opts: { download?: boolean } = {},
): Promise<string> {
  const filename = key.split("/").pop() ?? "download";
  const command = new GetObjectCommand({
    Bucket: env.s3Bucket(),
    Key: key,
    ResponseContentDisposition: opts.download
      ? `attachment; filename="${filename}"`
      : undefined,
  });
  return getSignedUrl(s3(), command, {
    expiresIn: env.presignExpirySeconds(),
  });
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(
    new DeleteObjectCommand({ Bucket: env.s3Bucket(), Key: key }),
  );
}

/** True if an object exists at the given key. */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: env.s3Bucket(), Key: key }));
    return true;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      ("name" in err) &&
      ((err as { name?: string }).name === "NotFound" ||
        (err as { name?: string }).name === "NoSuchKey")
    ) {
      return false;
    }
    // 404 surfaced via HTTP metadata on some S3-compatible servers.
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw err;
  }
}

/** Reads an object's full body into a Buffer. */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await s3().send(
    new GetObjectCommand({ Bucket: env.s3Bucket(), Key: key }),
  );
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

/** Writes a buffer to S3 with the given content type. */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.s3Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export interface ListedFolder {
  /** Full prefix, e.g. "jims-wedding/" or "uploads/jims-wedding/". */
  prefix: string;
}

/** Lists immediate "folders" (CommonPrefixes) under a prefix. */
export async function listFolders(params: {
  prefix: string;
  cursor?: string | null;
  maxKeys?: number;
}): Promise<{ folders: ListedFolder[]; nextCursor: string | null }> {
  const res = await s3().send(
    new ListObjectsV2Command({
      Bucket: env.s3Bucket(),
      Prefix: params.prefix,
      Delimiter: "/",
      MaxKeys: params.maxKeys ?? 1000,
      ContinuationToken: params.cursor || undefined,
    }),
  );
  const folders = (res.CommonPrefixes ?? [])
    .map((p) => p.Prefix)
    .filter((p): p is string => Boolean(p))
    .map((prefix) => ({ prefix }));
  return {
    folders,
    nextCursor: res.IsTruncated ? res.NextContinuationToken ?? null : null,
  };
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: string | null;
}

export interface ListObjectsResult {
  objects: ListedObject[];
  nextCursor: string | null;
  isTruncated: boolean;
}

/** Lists objects under a prefix with S3-native (continuation-token) paging. */
export async function listObjects(params: {
  prefix: string;
  maxKeys: number;
  cursor?: string | null;
}): Promise<ListObjectsResult> {
  const res = await s3().send(
    new ListObjectsV2Command({
      Bucket: env.s3Bucket(),
      Prefix: params.prefix,
      MaxKeys: params.maxKeys,
      ContinuationToken: params.cursor || undefined,
    }),
  );

  const objects: ListedObject[] = (res.Contents ?? [])
    // Skip "directory marker" keys (zero-byte keys ending in "/").
    .filter((o: _Object) => o.Key && !o.Key.endsWith("/"))
    .map((o: _Object) => ({
      key: o.Key as string,
      size: o.Size ?? 0,
      lastModified: o.LastModified ? o.LastModified.toISOString() : null,
    }));

  return {
    objects,
    nextCursor: res.NextContinuationToken ?? null,
    isTruncated: Boolean(res.IsTruncated),
  };
}

/**
 * Counts objects under a prefix, stopping once `limit` is reached (so an
 * upload cap can be enforced without scanning an unbounded number of keys).
 * Returns a count that is accurate up to `limit`.
 */
export async function countObjects(
  prefix: string,
  limit: number,
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const res = await s3().send(
      new ListObjectsV2Command({
        Bucket: env.s3Bucket(),
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: cursor,
      }),
    );
    count += (res.Contents ?? []).filter(
      (o: _Object) => o.Key && !o.Key.endsWith("/"),
    ).length;
    cursor = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (cursor && count < limit);
  return count;
}
