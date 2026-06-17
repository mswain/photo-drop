"use client";

import { useState } from "react";
import { KeyPhotos } from "./key-photos";
import { FolderLinks } from "./folder-links";
import type { UploadConfig } from "./folder-uploader";

/**
 * Folder view with Photos as the primary tab and Share links tucked behind a
 * secondary tab. Both stay mounted (toggled via display) so their state —
 * selection, loaded thumbnails — survives switching tabs.
 */
export function FolderView({
  slug,
  uploadConfig,
}: {
  slug: string;
  uploadConfig: UploadConfig;
}) {
  const [tab, setTab] = useState<"photos" | "links">("photos");

  return (
    <div>
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "photos"}
          className={`tab ${tab === "photos" ? "is-active" : ""}`}
          onClick={() => setTab("photos")}
        >
          Photos
        </button>
        <button
          role="tab"
          aria-selected={tab === "links"}
          className={`tab ${tab === "links" ? "is-active" : ""}`}
          onClick={() => setTab("links")}
        >
          Share links
        </button>
      </div>

      <div style={{ display: tab === "photos" ? "block" : "none" }}>
        <KeyPhotos slug={slug} uploadConfig={uploadConfig} />
      </div>
      <div style={{ display: tab === "links" ? "block" : "none" }}>
        <FolderLinks slug={slug} />
      </div>
    </div>
  );
}
