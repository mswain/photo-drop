"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client-fetch";

interface PhotoItem {
  key: string;
  filename: string;
  size: number;
  lastModified: string | null;
  isVideo: boolean;
  downloadUrl: string;
}

interface ImageInfo {
  width: number | null;
  height: number | null;
  density: number | null;
  format: string | null;
  colorSpace: string | null;
  hasAlpha: boolean;
  // Timezone-less EXIF wall-clock time ("YYYY-MM-DDTHH:mm:ss"); parsing it
  // with new Date() treats it as local, which keeps the displayed wall time
  // identical to what the camera recorded.
  dateTaken: string | null;
}

type ThumbState = {
  status: "loading" | "ready" | "error";
  url?: string;
  error?: string;
  // Original's technical metadata, returned alongside the thumbnail URL
  // (null when the server couldn't extract it).
  info?: ImageInfo | null;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "4032 × 3024 (12.2 MP) · 300 DPI · JPEG · sRGB" from whatever fields exist. */
function formatImageInfo(info: ImageInfo): string {
  const parts: string[] = [];
  if (info.width && info.height) {
    const mp = (info.width * info.height) / 1_000_000;
    parts.push(
      `${info.width} × ${info.height}${mp >= 0.1 ? ` (${mp.toFixed(1)} MP)` : ""}`,
    );
  }
  if (info.density) parts.push(`${info.density} DPI`);
  if (info.format) {
    parts.push(info.format === "jpeg" ? "JPEG" : info.format.toUpperCase());
  }
  if (info.colorSpace) {
    parts.push(info.colorSpace === "srgb" ? "sRGB" : info.colorSpace.toUpperCase());
  }
  if (info.hasAlpha) parts.push("alpha");
  return parts.join(" · ");
}

/** Small thumbnail shown to the left of a row's filename. The image bytes load
 * straight from S3 via the presigned URL, so they never transit the app.
 * Videos aren't image-thumbnailable, so they get a play-glyph placeholder. */
function ThumbBox({ state, isVideo }: { state?: ThumbState; isVideo?: boolean }) {
  if (isVideo) {
    return (
      <span className="thumb-video" aria-hidden="true">
        ▶
      </span>
    );
  }
  if (state?.status === "ready" && state.url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={state.url} alt="" loading="lazy" />;
  }
  if (state?.status === "error") {
    return (
      <span className="thumb-fallback" aria-hidden="true">
        ⚠
      </span>
    );
  }
  return <span className="spinner" aria-hidden="true" />;
}

/** Downloads a list of presigned S3 URLs by clicking hidden anchors. */
async function triggerDownloads(urls: string[]) {
  for (const url of urls) {
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Small gap so browsers don't coalesce/block the batch.
    await new Promise((r) => setTimeout(r, 300));
  }
}

export function KeyPhotos({ slug }: { slug: string }) {
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pageSize, setPageSize] = useState(50);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Selection + preview.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, ThumbState>>({});
  // Inline playback URLs for video items, fetched lazily when previewed.
  const [videoUrls, setVideoUrls] = useState<Record<string, ThumbState>>({});

  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(new Set()); // selection is per page

    const params = new URLSearchParams();
    params.set("slug", slug);
    if (cursor) params.set("cursor", cursor);
    params.set("pageSize", String(pageSize));

    apiFetch(`/api/admin/photos?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || "Failed to load photos");
        }
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setItems(d.items);
        setNextCursor(d.nextCursor);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [slug, pageSize, cursor, reloadKey]);

  // Indeterminate state for the header checkbox.
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selected.size > 0 && selected.size < items.length;
    }
  }, [selected, items.length]);

  function toggleOne(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.key)),
    );
  }

  async function downloadKeys(keys: string[]) {
    if (keys.length === 0) return;
    setBusy(true);
    try {
      const res = await apiFetch("/api/admin/photos/download-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      });
      if (!res.ok) throw new Error("Could not prepare downloads");
      const { urls } = (await res.json()) as { urls: { key: string; url: string }[] };
      await triggerDownloads(urls.map((u) => u.url));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteKeys(keys: string[], closePreview = false) {
    if (keys.length === 0) return;
    const label =
      keys.length === 1 ? "this photo" : `${keys.length} selected photos`;
    if (!confirm(`Permanently delete ${label} from storage?`)) return;
    setBusy(true);
    try {
      // fetch() doesn't reject on HTTP errors, so check each response and only
      // drop the keys that actually deleted — otherwise a failed delete would
      // silently disappear from the list.
      const results = await Promise.all(
        keys.map(async (key) => {
          const res = await apiFetch(
            `/api/admin/photos?key=${encodeURIComponent(key)}`,
            { method: "DELETE" },
          );
          return { key, ok: res.ok };
        }),
      );
      const deleted = new Set(results.filter((r) => r.ok).map((r) => r.key));
      if (deleted.size > 0) {
        setItems((prev) => prev.filter((p) => !deleted.has(p.key)));
        setSelected((prev) => {
          const next = new Set(prev);
          deleted.forEach((k) => next.delete(k));
          return next;
        });
        if (closePreview) setPreview(null);
      }
      const failed = keys.length - deleted.size;
      if (failed > 0) {
        alert(`Failed to delete ${failed} photo${failed === 1 ? "" : "s"}.`);
      }
    } catch {
      alert("Delete failed");
    } finally {
      setBusy(false);
    }
  }

  // ---- preview thumbnails ----
  // Keys whose thumbnail we've already requested, so each is fetched at most
  // once (a ref, not state, keeps the dedupe out of the render/updater cycle).
  const requestedThumbs = useRef<Set<string>>(new Set());
  const ensureThumb = useCallback((key: string): Promise<void> => {
    if (requestedThumbs.current.has(key)) return Promise.resolve();
    requestedThumbs.current.add(key);
    setThumbs((s) => ({ ...s, [key]: { status: "loading" } }));
    return apiFetch(`/api/admin/photos/thumbnail?key=${encodeURIComponent(key)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        setThumbs((s) => ({
          ...s,
          [key]: r.ok
            ? { status: "ready", url: d.url, info: d.info ?? null }
            : { status: "error", error: d.error || "Preview failed" },
        }));
      })
      .catch(() =>
        setThumbs((s) => ({ ...s, [key]: { status: "error", error: "Preview failed" } })),
      );
  }, []);

  // Lazily fetch a presigned inline playback URL for a video, at most once per
  // key. The video bytes stream directly from S3; only the JSON handshake
  // touches the app.
  const requestedVideos = useRef<Set<string>>(new Set());
  const ensureVideoUrl = useCallback((key: string): Promise<void> => {
    if (requestedVideos.current.has(key)) return Promise.resolve();
    requestedVideos.current.add(key);
    setVideoUrls((s) => ({ ...s, [key]: { status: "loading" } }));
    return apiFetch(`/api/admin/photos/play?key=${encodeURIComponent(key)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        setVideoUrls((s) => ({
          ...s,
          [key]: r.ok
            ? { status: "ready", url: d.url }
            : { status: "error", error: d.error || "Could not load video" },
        }));
      })
      .catch(() =>
        setVideoUrls((s) => ({
          ...s,
          [key]: { status: "error", error: "Could not load video" },
        })),
      );
  }, []);

  // Eagerly generate/fetch a thumbnail for every row on the current page, in the
  // background and capped at a few in flight so a 100-photo page doesn't fire 100
  // generation requests at once. ensureThumb dedupes, so keys already loaded (by
  // the preview, or a revisited page) are skipped. The endpoint hands back a
  // presigned S3 URL, so only the small JSON handshake touches the app — the
  // actual thumbnail bytes load directly from S3.
  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    // Videos aren't image-thumbnailable — they get a placeholder, not a fetch.
    const queue = items.filter((i) => !i.isVideo).map((i) => i.key);
    const CONCURRENCY = 4;

    async function worker() {
      while (!cancelled) {
        const key = queue.shift();
        if (!key) return;
        await ensureThumb(key);
      }
    }

    void Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
    );

    return () => {
      cancelled = true;
    };
  }, [items, ensureThumb]);

  const ensurePreview = useCallback(
    (item: PhotoItem) => {
      if (item.isVideo) ensureVideoUrl(item.key);
      else ensureThumb(item.key);
    },
    [ensureThumb, ensureVideoUrl],
  );

  const openPreview = useCallback(
    (index: number) => {
      setPreview(index);
      const item = items[index];
      if (item) ensurePreview(item);
    },
    [items, ensurePreview],
  );

  const navigate = useCallback(
    (delta: number) => {
      setPreview((cur) => {
        if (cur == null) return cur;
        const next = cur + delta;
        if (next < 0 || next >= items.length) return cur;
        ensurePreview(items[next]);
        return next;
      });
    },
    [items, ensurePreview],
  );

  useEffect(() => {
    if (preview == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPreview(null);
      else if (e.key === "ArrowLeft") navigate(-1);
      else if (e.key === "ArrowRight") navigate(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, navigate]);

  function resetPaging(fn: () => void) {
    setHistory([]);
    setCursor(undefined);
    fn();
  }

  const page = history.length + 1;
  const current = preview != null ? items[preview] : null;
  const currentThumb = current ? thumbs[current.key] : undefined;
  const currentVideo = current ? videoUrls[current.key] : undefined;
  const selectedKeys = [...selected];

  return (
    <div>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: "0.85rem" }}>
        <button className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
          Refresh
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        {loading ? (
          <p className="muted" style={{ margin: 0 }}>
            Loading…
          </p>
        ) : items.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No photos in this folder yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      aria-label="Select all"
                      checked={items.length > 0 && selected.size === items.length}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Uploaded</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={item.key} className={selected.has(item.key) ? "is-selected" : ""}>
                    <td className="col-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.filename}`}
                        checked={selected.has(item.key)}
                        onChange={() => toggleOne(item.key)}
                      />
                    </td>
                    <td>
                      <div className="thumb-cell">
                        <button
                          type="button"
                          className="thumb-box"
                          onClick={() => openPreview(idx)}
                          aria-label={`Preview ${item.filename}`}
                        >
                          <ThumbBox state={thumbs[item.key]} isVideo={item.isVideo} />
                        </button>
                        <button className="link-cell mono" onClick={() => openPreview(idx)}>
                          {item.filename}
                        </button>
                      </div>
                    </td>
                    <td className="muted">{formatBytes(item.size)}</td>
                    <td className="muted">
                      {item.lastModified
                        ? new Date(item.lastModified).toLocaleString()
                        : "—"}
                    </td>
                    <td className="col-actions">
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button className="btn btn-sm preview-btn" onClick={() => openPreview(idx)}>
                          Preview
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => deleteKeys([item.key])}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="row-between pager">
          <span className="muted small">Page {page}</span>
          <div className="row">
            <select
              className="input input-sm"
              value={pageSize}
              onChange={(e) => resetPaging(() => setPageSize(Number(e.target.value)))}
            >
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
              <option value={100}>100 / page</option>
            </select>
            <button
              className="btn btn-sm"
              disabled={history.length === 0 || loading}
              onClick={() =>
                setHistory((h) => {
                  if (h.length === 0) return h;
                  const copy = [...h];
                  setCursor(copy.pop());
                  return copy;
                })
              }
            >
              ← Previous
            </button>
            <button
              className="btn btn-sm"
              disabled={!nextCursor || loading}
              onClick={() => {
                setHistory((h) => [...h, cursor]);
                setCursor(nextCursor ?? undefined);
              }}
            >
              Next →
            </button>
          </div>
        </div>
      </div>

      {current && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="mono small" style={{ wordBreak: "break-all" }}>
                {current.filename}
              </span>
              <button className="btn btn-sm btn-ghost" onClick={() => setPreview(null)}>
                ✕
              </button>
            </div>

            <div className="modal-image">
              {current.isVideo ? (
                !currentVideo || currentVideo.status === "loading" ? (
                  <div className="muted spinner-wrap">
                    <span className="spinner" /> Loading video…
                  </div>
                ) : currentVideo.status === "error" ? (
                  <div className="muted" style={{ textAlign: "center" }}>
                    {currentVideo.error}
                    <br />
                    <a className="btn btn-sm" href={current.downloadUrl} style={{ marginTop: "0.5rem" }}>
                      Download original
                    </a>
                  </div>
                ) : (
                  <video src={currentVideo.url} controls playsInline preload="metadata" />
                )
              ) : !currentThumb || currentThumb.status === "loading" ? (
                <div className="muted spinner-wrap">
                  <span className="spinner" /> Generating preview…
                </div>
              ) : currentThumb.status === "error" ? (
                <div className="muted" style={{ textAlign: "center" }}>
                  {currentThumb.error}
                  <br />
                  <a className="btn btn-sm" href={current.downloadUrl} style={{ marginTop: "0.5rem" }}>
                    Download original
                  </a>
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={currentThumb.url} alt={current.filename} />
              )}
            </div>

            <div className="small muted" style={{ marginTop: "0.6rem" }}>
              {formatBytes(current.size)}
              {(() => {
                if (!current.isVideo && currentThumb?.status === "loading") {
                  return " · …";
                }
                const text = currentThumb?.info
                  ? formatImageInfo(currentThumb.info)
                  : "";
                return text ? ` · ${text}` : "";
              })()}
              {currentThumb?.info?.dateTaken
                ? ` · Taken ${new Date(currentThumb.info.dateTaken).toLocaleString()}`
                : ""}
              {current.lastModified
                ? ` · Uploaded ${new Date(current.lastModified).toLocaleString()}`
                : ""}
            </div>

            <div className="row-between modal-actions">
              <div className="row">
                <button className="btn btn-sm" disabled={preview === 0} onClick={() => navigate(-1)}>
                  ← Prev
                </button>
                <button
                  className="btn btn-sm"
                  disabled={preview === items.length - 1}
                  onClick={() => navigate(1)}
                >
                  Next →
                </button>
              </div>
              <div className="row">
                <a className="btn btn-sm btn-primary" href={current.downloadUrl}>
                  Download
                </a>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => deleteKeys([current.key], true)}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating selection bar — fixed, so it never reflows the list. */}
      {selected.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Selection actions">
          <span>
            <strong>{selected.size}</strong> selected
          </span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => downloadKeys(selectedKeys)}
            >
              {busy ? "Working…" : `Download ${selected.size}`}
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => deleteKeys(selectedKeys)}
            >
              Delete
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
