"use client";

import { useRef, useState } from "react";
import { apiFetch } from "@/lib/client-fetch";

type FileStatus = "queued" | "uploading" | "done" | "error";

interface FileItem {
  id: string;
  file: File;
  status: FileStatus;
  progress: number; // 0..100
  error?: string;
  retryable?: boolean;
}

const CONCURRENCY = 4;

// Files larger than this are uploaded via S3 multipart (parallel parts, each
// with its own presigned URL); smaller files take the simpler single-PUT path.
// 100 MiB matches the server's part size.
const MULTIPART_THRESHOLD = 100 * 1024 * 1024;

/** Server-derived upload settings threaded down to the admin uploader. */
export interface UploadConfig {
  maxBatchSize: number;
  acceptPrefixes: string[];
}

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
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

/**
 * PUTs one multipart part to S3 and returns its ETag (needed to complete the
 * upload). The bucket's CORS must expose the ETag response header — the repo's
 * s3-cors.json does.
 */
function putPart(
  url: string,
  blob: Blob,
  onProgress: (loadedBytes: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
        return;
      }
      const etag = xhr.getResponseHeader("ETag");
      if (etag) resolve(etag);
      else reject(new Error("Upload succeeded but S3 returned no ETag."));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(blob);
  });
}

/**
 * Admin-only uploader shown inside a registered folder. Unlike the public
 * uploader it has no per-file size cap — an admin can upload originals of
 * arbitrary size (up to S3's single-PUT ceiling, enforced server-side). Files
 * go straight to S3 via presigned URLs; only the JSON handshake touches the app.
 */
export function FolderUploader({
  slug,
  maxBatchSize,
  acceptPrefixes,
  onUploaded,
}: {
  slug: string;
  maxBatchSize: number;
  acceptPrefixes: string[];
  onUploaded: () => void;
}) {
  const [items, setItems] = useState<FileItem[]>([]);
  const [activeBatches, setActiveBatches] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploading = activeBatches > 0;
  const acceptAttr = acceptPrefixes.map((p) => `${p}*`).join(",");

  function update(id: string, patch: Partial<FileItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    setTopError(null);
    const added: FileItem[] = [];
    for (const file of Array.from(fileList)) {
      const type = file.type.toLowerCase();
      // No size check — admins may upload arbitrarily large files. Only the
      // media-type filter applies (matched server-side too).
      const wrongType = !acceptPrefixes.some((p) => type.startsWith(p));
      added.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: wrongType ? "error" : "queued",
        progress: 0,
        error: wrongType ? "Unsupported file type" : undefined,
      });
    }
    setItems((prev) => [...prev, ...added]);
    if (inputRef.current) inputRef.current.value = "";

    enqueue(added.filter((it) => it.status === "queued"));
  }

  /**
   * Dispatches files by size: large files each take their own multipart upload,
   * small files share the batched single-PUT path.
   */
  function enqueue(batch: FileItem[]) {
    if (batch.length === 0) return;
    const small = batch.filter((it) => it.file.size <= MULTIPART_THRESHOLD);
    const large = batch.filter((it) => it.file.size > MULTIPART_THRESHOLD);
    if (small.length > 0) void startUpload(small);
    for (const it of large) void startLargeUpload(it);
  }

  /** Uploads an explicit batch of files. Safe to run concurrently. */
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
      // Reveal whatever landed, even if some files in the batch failed.
      onUploaded();
    }
  }

  /** Presigns and uploads one chunk (at most maxBatchSize files). */
  async function uploadChunk(batch: FileItem[]) {
    try {
      const res = await apiFetch(`/api/admin/folders/${slug}/presign`, {
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
      const jobs = batch.map((it, idx) => ({ item: it, url: data.uploads[idx].url }));

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

  /** Uploads one large file via S3 multipart, reporting aggregate progress. */
  async function startLargeUpload(item: FileItem) {
    setActiveBatches((n) => n + 1);
    setTopError(null);
    update(item.id, { status: "uploading", progress: 0, error: undefined });
    try {
      await multipartUpload(item);
      update(item.id, { status: "done", progress: 100 });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Upload failed";
      setTopError(message);
      update(item.id, { status: "error", retryable: true, error: message });
    } finally {
      setActiveBatches((n) => n - 1);
      onUploaded();
    }
  }

  async function multipartUpload(item: FileItem) {
    const file = item.file;

    // 1) Start the upload; the server hands back a presigned PUT URL per part.
    const createRes = await apiFetch(`/api/admin/folders/${slug}/multipart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "create",
        contentType: file.type || "application/octet-stream",
        size: file.size,
      }),
    });
    if (!createRes.ok) {
      const data = await createRes.json().catch(() => ({}));
      throw new Error(data.error || "Could not start the upload.");
    }
    const { key, uploadId, partSize, urls } = (await createRes.json()) as {
      key: string;
      uploadId: string;
      partSize: number;
      urls: { partNumber: number; url: string }[];
    };

    try {
      // 2) Upload the parts with bounded concurrency, summing bytes for a single
      //    file-level progress bar. Hold at 99% until complete() confirms.
      const loaded = new Array<number>(urls.length).fill(0);
      const reportProgress = () => {
        const sum = loaded.reduce((a, b) => a + b, 0);
        update(item.id, {
          progress: Math.min(99, Math.round((sum / file.size) * 100)),
        });
      };

      const parts = new Array<{ partNumber: number; etag: string }>(urls.length);
      let cursor = 0;
      async function worker() {
        while (cursor < urls.length) {
          const i = cursor++;
          const { partNumber, url } = urls[i];
          const start = i * partSize;
          const blob = file.slice(start, Math.min(start + partSize, file.size));
          const etag = await putPart(url, blob, (bytes) => {
            loaded[i] = bytes;
            reportProgress();
          });
          loaded[i] = blob.size;
          reportProgress();
          parts[i] = { partNumber, etag };
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker),
      );

      // 3) Stitch the parts into the final object.
      const completeRes = await apiFetch(`/api/admin/folders/${slug}/multipart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "complete", key, uploadId, parts }),
      });
      if (!completeRes.ok) {
        const data = await completeRes.json().catch(() => ({}));
        throw new Error(data.error || "Could not finish the upload.");
      }
    } catch (e) {
      // Best-effort: discard the partial upload so its parts aren't billed.
      void apiFetch(`/api/admin/folders/${slug}/multipart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "abort", key, uploadId }),
      }).catch(() => {});
      throw e;
    }
  }

  function retryFailed() {
    const failed = items.filter((it) => it.status === "error" && it.retryable);
    enqueue(failed);
  }

  function clearFinished() {
    setItems((prev) => prev.filter((it) => it.status !== "done"));
  }

  const doneCount = items.filter((it) => it.status === "done").length;
  const retryableCount = items.filter(
    (it) => it.status === "error" && it.retryable,
  ).length;

  return (
    <div className="card" style={{ marginBottom: "0.85rem" }}>
      {topError && <div className="alert alert-error">{topError}</div>}

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
        <div className="dropzone-icon" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M17 8l-5-5-5 5" />
            <path d="M12 3v12" />
          </svg>
        </div>
        <p style={{ margin: 0, fontWeight: 620 }}>
          {dragActive ? "Drop to upload" : "Tap or drag files here to add to this folder"}
        </p>
        <p className="muted small" style={{ margin: "0.35rem 0 0" }}>
          Uploading starts automatically · no size limit
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={acceptAttr}
          multiple
          hidden
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      {items.length > 0 && (
        <>
          <ul className="file-list" style={{ marginTop: "0.85rem" }}>
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
                    <div className="progress-bar" style={{ width: `${it.progress}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>

          {(retryableCount > 0 || doneCount > 0) && !uploading && (
            <div className="row" style={{ marginTop: "0.85rem" }}>
              {retryableCount > 0 && (
                <button className="btn btn-sm btn-primary" onClick={retryFailed}>
                  Retry {retryableCount} failed
                </button>
              )}
              {doneCount > 0 && (
                <button className="btn btn-sm" onClick={clearFinished}>
                  Clear finished
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
