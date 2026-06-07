"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client-fetch";

interface PhotoItem {
  key: string;
  filename: string;
  size: number;
  lastModified: string | null;
  downloadUrl: string;
}

type ThumbState = { status: "loading" | "ready" | "error"; url?: string; error?: string };

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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
      const { urls } = await res.json();
      await triggerDownloads(urls.map((u: { url: string }) => u.url));
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
      await Promise.all(
        keys.map((key) =>
          apiFetch(`/api/admin/photos?key=${encodeURIComponent(key)}`, {
            method: "DELETE",
          }),
        ),
      );
      const removed = new Set(keys);
      setItems((prev) => prev.filter((p) => !removed.has(p.key)));
      setSelected((prev) => {
        const next = new Set(prev);
        keys.forEach((k) => next.delete(k));
        return next;
      });
      if (closePreview) setPreview(null);
    } catch {
      alert("Delete failed");
    } finally {
      setBusy(false);
    }
  }

  // ---- preview thumbnails ----
  const ensureThumb = useCallback((key: string) => {
    setThumbs((prev) => {
      if (prev[key]) return prev;
      apiFetch(`/api/admin/photos/thumbnail?key=${encodeURIComponent(key)}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          setThumbs((s) => ({
            ...s,
            [key]: r.ok
              ? { status: "ready", url: d.url }
              : { status: "error", error: d.error || "Preview failed" },
          }));
        })
        .catch(() =>
          setThumbs((s) => ({ ...s, [key]: { status: "error", error: "Preview failed" } })),
        );
      return { ...prev, [key]: { status: "loading" } };
    });
  }, []);

  const openPreview = useCallback(
    (index: number) => {
      setPreview(index);
      const item = items[index];
      if (item) ensureThumb(item.key);
    },
    [items, ensureThumb],
  );

  const navigate = useCallback(
    (delta: number) => {
      setPreview((cur) => {
        if (cur == null) return cur;
        const next = cur + delta;
        if (next < 0 || next >= items.length) return cur;
        ensureThumb(items[next].key);
        return next;
      });
    },
    [items, ensureThumb],
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
            <table className="table">
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
                      <button className="link-cell mono" onClick={() => openPreview(idx)}>
                        {item.filename}
                      </button>
                    </td>
                    <td className="muted">{formatBytes(item.size)}</td>
                    <td className="muted">
                      {item.lastModified
                        ? new Date(item.lastModified).toLocaleString()
                        : "—"}
                    </td>
                    <td className="col-actions">
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button className="btn btn-sm" onClick={() => openPreview(idx)}>
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
              {!currentThumb || currentThumb.status === "loading" ? (
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
              {current.lastModified
                ? ` · ${new Date(current.lastModified).toLocaleString()}`
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
