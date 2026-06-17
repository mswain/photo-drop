import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { env } from "@/lib/env";
import { KeyPhotos } from "./key-photos";
import { FolderView } from "./folder-view";
import { DeleteFolderButton } from "./delete-folder-button";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  return { title: `${slug} · Photos · Photo Drop` };
}

export default async function FolderPage({ params }: Props) {
  const { slug } = await params;

  const [folder] = await db
    .select({ label: folders.label })
    .from(folders)
    .where(eq(folders.slug, slug))
    .limit(1);

  return (
    <div>
      <div className="small breadcrumb">
        <Link href="/admin/photos">← All folders</Link>
      </div>
      <div className="row-between page-head">
        <div>
          <h1>{folder?.label ?? slug}</h1>
          <span className="muted mono small">{slug}/</span>
        </div>
        <DeleteFolderButton slug={slug} confirmName={folder?.label ?? slug} />
      </div>

      {folder ? (
        <FolderView
          slug={slug}
          uploadConfig={{
            maxBatchSize: env.maxBatchSize(),
            acceptPrefixes: env.allowedContentTypePrefixes(),
          }}
        />
      ) : (
        <>
          <div className="alert alert-info">
            This folder isn&apos;t registered, but its files still exist in
            storage below. Create a folder with this name to share it again.
          </div>
          <KeyPhotos slug={slug} />
        </>
      )}
    </div>
  );
}
