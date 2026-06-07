"use client";

import { useRef, useState } from "react";

type FileStatus = "queued" | "uploading" | "done" | "error";

interface FileItem {
  id: string;
  file: File;
  status: FileStatus;
  progress: number; // 0..100
  error?: string;
}

const CONCURRENCY = 4;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** PUTs a file directly to S3 using a presigned URL, reporting progress. */
function putToS3(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

export function Uploader({
  token,
  label,
  maxBytes,
  acceptPrefix,
}: {
  token: string;
  label: string | null;
  maxBytes: number;
  acceptPrefix: string;
}) {
  const [items, setItems] = useState<FileItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const maxMb = Math.floor(maxBytes / (1024 * 1024));

  function update(id: string, patch: Partial<FileItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    setTopError(null);
    const added: FileItem[] = [];
    for (const file of Array.from(fileList)) {
      const tooBig = file.size > maxBytes;
      const wrongType = !file.type.toLowerCase().startsWith(acceptPrefix);
      added.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: tooBig || wrongType ? "error" : "queued",
        progress: 0,
        error: tooBig
          ? `Larger than ${maxMb} MB`
          : wrongType
            ? "Not an image"
            : undefined,
      });
    }
    setItems((prev) => [...prev, ...added]);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function startUpload() {
    const queued = items.filter((it) => it.status === "queued");
    if (queued.length === 0) return;

    setUploading(true);
    setTopError(null);

    try {
      // 1) Ask the server for one presigned PUT URL per file.
      const res = await fetch(`/api/upload/${token}/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: queued.map((it) => ({
            contentType: it.file.type || "application/octet-stream",
            size: it.file.size,
          })),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not start the upload.");
      }

      const data: { uploads: { key: string; url: string }[] } = await res.json();
      const presigned = data.uploads;

      // Pair each queued file with its presigned URL (same order).
      const jobs = queued.map((it, idx) => ({ item: it, url: presigned[idx].url }));

      // 2) Upload directly to S3 with bounded concurrency.
      let cursor = 0;
      async function worker() {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          update(job.item.id, { status: "uploading", progress: 0 });
          try {
            await putToS3(job.url, job.item.file, (pct) =>
              update(job.item.id, { progress: pct }),
            );
            update(job.item.id, { status: "done", progress: 100 });
          } catch (e) {
            update(job.item.id, {
              status: "error",
              error: e instanceof Error ? e.message : "Upload failed",
            });
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker),
      );
    } catch (e) {
      setTopError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function clearFinished() {
    setItems((prev) => prev.filter((it) => it.status !== "done"));
  }

  const queuedCount = items.filter((it) => it.status === "queued").length;
  const doneCount = items.filter((it) => it.status === "done").length;
  const totalSelected = items.length;
  const allDone =
    totalSelected > 0 && items.every((it) => it.status === "done" || it.status === "error");

  return (
    <div className="upload-shell">
      <div className="container-narrow" style={{ width: "100%" }}>
        <h1 style={{ textAlign: "center" }}>Upload photos</h1>
        {label && (
          <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
            {label}
          </p>
        )}

        {topError && <div className="alert alert-error">{topError}</div>}

        {allDone && doneCount > 0 && (
          <div className="alert alert-success">
            {doneCount} photo{doneCount === 1 ? "" : "s"} uploaded. Thank you!
          </div>
        )}

        <div
          className="dropzone"
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
        >
          <input
            ref={inputRef}
            type="file"
            accept={`${acceptPrefix}*`}
            multiple
            hidden
            onChange={(e) => addFiles(e.target.files)}
          />
          <div className="dropzone-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M17 8l-5-5-5 5" />
              <path d="M12 3v12" />
            </svg>
          </div>
          <p style={{ margin: 0, fontWeight: 620, fontSize: "1.02rem" }}>
            Tap to choose photos
          </p>
          <p className="muted small" style={{ margin: "0.35rem 0 0" }}>
            You can select multiple at once · up to {maxMb} MB each
          </p>
        </div>

        {items.length > 0 && (
          <>
            <ul className="file-list">
              {items.map((it) => (
                <li key={it.id} className="file-item">
                  <div className="file-item-head">
                    <span className="mono" style={{ wordBreak: "break-all" }}>
                      {it.file.name}
                    </span>
                    <span className="muted">{formatBytes(it.file.size)}</span>
                  </div>
                  {it.status === "error" ? (
                    <span className="status-error small">✕ {it.error}</span>
                  ) : it.status === "done" ? (
                    <span className="status-done small">✓ Uploaded</span>
                  ) : (
                    <div className="progress">
                      <div
                        className="progress-bar"
                        style={{ width: `${it.progress}%` }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <div
              className="row"
              style={{ marginTop: "1.25rem", justifyContent: "center" }}
            >
              <button
                className="btn btn-primary"
                onClick={startUpload}
                disabled={uploading || queuedCount === 0}
              >
                {uploading
                  ? "Uploading…"
                  : queuedCount > 0
                    ? `Upload ${queuedCount} photo${queuedCount === 1 ? "" : "s"}`
                    : "Nothing to upload"}
              </button>
              {doneCount > 0 && !uploading && (
                <button className="btn" onClick={clearFinished}>
                  Clear finished
                </button>
              )}
            </div>

            <p className="muted small" style={{ textAlign: "center", marginTop: "0.75rem" }}>
              {doneCount}/{totalSelected} uploaded
            </p>
          </>
        )}
      </div>
    </div>
  );
}
