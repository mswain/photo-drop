import "dotenv/config";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

/**
 * Creates the S3 bucket (idempotent). Used by the dev Makefile to provision the
 * bucket inside MiniStack, but works against any S3 endpoint the env points at.
 */
async function main() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET is required");

  const s3 = new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });

  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Created bucket "${bucket}".`);
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
      console.log(`Bucket "${bucket}" already exists.`);
    } else {
      throw err;
    }
  }

  // Sanity check it's reachable.
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
}

main().catch((err) => {
  console.error("Failed to create bucket:", err?.message ?? err);
  process.exit(1);
});
