"use client";

import { useRef, useState } from "react";

type FileStatus = "queued" | "uploading" | "done" | "error";

interface FileItem {
  id: string;
  file: File;
  status: FileStatus;
  progress: number; // 0..100
  error?: string;
  retryable?: boolean; // true for upload/network failures (re-sending may succeed)
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

/** Human label for the kinds of files an upload link accepts. */
function mediaNoun(prefixes: string[]): { plural: string; singular: string } {
  const images = prefixes.some((p) => p.startsWith("image/"));
  const videos = prefixes.some((p) => p.startsWith("video/"));
  if (images && videos)
    return { plural: "photos & videos", singular: "photo or video" };
  if (videos) return { plural: "videos", singular: "video" };
  return { plural: "photos", singular: "photo" };
}

/** A whole-number size cap label, e.g. "50 MB" or "2 GB". */
function formatCap(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

export function Uploader({
  token,
  label,
  maxImageBytes,
  maxVideoBytes,
  acceptPrefixes,
  maxBatchSize,
}: {
  token: string;
  label: string | null;
  maxImageBytes: number;
  maxVideoBytes: number;
  acceptPrefixes: string[];
  maxBatchSize: number;
}) {
  const [items, setItems] = useState<FileItem[]>([]);
  const [activeBatches, setActiveBatches] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Derived from in-flight batches so concurrent selections don't race a flag.
  const uploading = activeBatches > 0;

  const noun = mediaNoun(acceptPrefixes);
  const acceptAttr = acceptPrefixes.map((p) => `${p}*`).join(",");
  const allowsImages = acceptPrefixes.some((p) => p.startsWith("image/"));
  const allowsVideos = acceptPrefixes.some((p) => p.startsWith("video/"));
  const sizeHint =
    allowsImages && allowsVideos
      ? `up to ${formatCap(maxImageBytes)} per photo · ${formatCap(maxVideoBytes)} per video`
      : `up to ${formatCap(allowsVideos ? maxVideoBytes : maxImageBytes)} each`;

  /** Per-file byte cap (videos get the larger limit). */
  function capFor(type: string): number {
    return type.toLowerCase().startsWith("video/") ? maxVideoBytes : maxImageBytes;
  }

  function update(id: string, patch: Partial<FileItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    setTopError(null);
    const added: FileItem[] = [];
    for (const file of Array.from(fileList)) {
      const type = file.type.toLowerCase();
      const cap = capFor(type);
      const tooBig = file.size > cap;
      const wrongType = !acceptPrefixes.some((p) => type.startsWith(p));
      added.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: tooBig || wrongType ? "error" : "queued",
        progress: 0,
        error: tooBig
          ? `Larger than ${formatCap(cap)}`
          : wrongType
            ? `Not a ${noun.singular}`
            : undefined,
      });
    }
    setItems((prev) => [...prev, ...added]);
    if (inputRef.current) inputRef.current.value = "";

    // Start uploading the valid files right away — no button press needed.
    const toUpload = added.filter((it) => it.status === "queued");
    if (toUpload.length > 0) void startUpload(toUpload);
  }

  /** Uploads an explicit batch of files. Safe to run concurrently with other batches. */
  async function startUpload(batch: FileItem[]) {
    if (batch.length === 0) return;

    setActiveBatches((n) => n + 1);
    setTopError(null);
    batch.forEach((it) =>
      update(it.id, { status: "uploading", progress: 0, error: undefined }),
    );

    try {
      // The presign endpoint caps how many files one request may describe, so
      // large selections are presigned and uploaded chunk by chunk.
      for (let i = 0; i < batch.length; i += maxBatchSize) {
        await uploadChunk(batch.slice(i, i + maxBatchSize));
      }
    } finally {
      setActiveBatches((n) => n - 1);
    }
  }

  /** Presigns and uploads one chunk (at most maxBatchSize files). */
  async function uploadChunk(batch: FileItem[]) {
    try {
      // 1) Ask the server for one presigned PUT URL per file.
      const res = await fetch(`/api/upload/${token}/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: batch.map((it) => ({
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

      // Pair each file with its presigned URL (same order).
      const jobs = batch.map((it, idx) => ({ item: it, url: presigned[idx].url }));

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
              retryable: true,
              error: e instanceof Error ? e.message : "Upload failed",
            });
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker),
      );
    } catch (e) {
      // Presigning failed for this chunk — mark its files retryable.
      const msg = e instanceof Error ? e.message : "Upload failed.";
      setTopError(msg);
      const ids = new Set(batch.map((it) => it.id));
      setItems((prev) =>
        prev.map((it) =>
          ids.has(it.id) && it.status !== "done"
            ? { ...it, status: "error", retryable: true, error: msg }
            : it,
        ),
      );
    }
  }

  /** Re-attempts files that failed for a transient reason (not validation errors). */
  function retryFailed() {
    const failed = items.filter((it) => it.status === "error" && it.retryable);
    if (failed.length > 0) void startUpload(failed);
  }

  function clearFinished() {
    setItems((prev) => prev.filter((it) => it.status !== "done"));
  }

  const doneCount = items.filter((it) => it.status === "done").length;
  const retryableCount = items.filter(
    (it) => it.status === "error" && it.retryable,
  ).length;
  const totalSelected = items.length;
  const allDone =
    !uploading &&
    totalSelected > 0 &&
    items.every((it) => it.status === "done" || it.status === "error");

  return (
    <div className="upload-shell">
      <div className="container-narrow" style={{ width: "100%" }}>
        <h1 style={{ textAlign: "center" }}>Upload {noun.plural}</h1>
        {label && (
          <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
            {label}
          </p>
        )}

        {topError && <div className="alert alert-error">{topError}</div>}

        {allDone && doneCount > 0 && (
          <div className="alert alert-success">
            {doneCount} file{doneCount === 1 ? "" : "s"} uploaded. Thank you!
          </div>
        )}

        <div
          className={`dropzone${dragActive ? " dropzone-active" : ""}`}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            addFiles(e.dataTransfer.files);
          }}
          role="button"
          tabIndex={0}
        >
          <input
            ref={inputRef}
            type="file"
            accept={acceptAttr}
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
            {dragActive ? `Drop to upload` : `Tap or drag ${noun.plural} here`}
          </p>
          <p className="muted small" style={{ margin: "0.35rem 0 0" }}>
            Uploading starts automatically · {sizeHint}
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

            {(retryableCount > 0 || doneCount > 0) && !uploading && (
              <div
                className="row"
                style={{ marginTop: "1.25rem", justifyContent: "center" }}
              >
                {retryableCount > 0 && (
                  <button className="btn btn-primary" onClick={retryFailed}>
                    Retry {retryableCount} failed
                  </button>
                )}
                {doneCount > 0 && (
                  <button className="btn" onClick={clearFinished}>
                    Clear finished
                  </button>
                )}
              </div>
            )}

            <p className="muted small" style={{ textAlign: "center", marginTop: "0.75rem" }}>
              {doneCount}/{totalSelected} uploaded
            </p>
          </>
        )}
      </div>
    </div>
  );
}
