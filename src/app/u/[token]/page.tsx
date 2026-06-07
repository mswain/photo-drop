import { eq } from "drizzle-orm";
import { db } from "@/db";
import { uploadLinks } from "@/db/schema";
import { env } from "@/lib/env";
import { Uploader } from "./uploader";
import { ThemeToggle } from "../../theme-toggle";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Upload photos",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ token: string }> };

function ErrorState({ message }: { message: string }) {
  return (
    <div className="center-screen">
      <div className="card container-narrow" style={{ textAlign: "center" }}>
        <h1>Upload unavailable</h1>
        <p className="muted">{message}</p>
      </div>
    </div>
  );
}

export default async function UploadPage({ params }: Props) {
  const { token } = await params;

  const [link] = await db
    .select()
    .from(uploadLinks)
    .where(eq(uploadLinks.token, token))
    .limit(1);

  let content;
  if (!link) {
    content = <ErrorState message="This upload link does not exist." />;
  } else if (!link.isActive) {
    content = <ErrorState message="This upload link has been disabled." />;
  } else if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    content = <ErrorState message="This upload link has expired." />;
  } else {
    content = (
      <Uploader
        token={token}
        label={link.label}
        maxBytes={env.maxUploadBytes()}
        acceptPrefix={env.allowedContentTypePrefix()}
      />
    );
  }

  return (
    <>
      <div className="theme-toggle-floating">
        <ThemeToggle />
      </div>
      {content}
    </>
  );
}
