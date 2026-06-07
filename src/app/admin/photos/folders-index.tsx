"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { slugify } from "@/lib/slug";
import { apiFetch } from "@/lib/client-fetch";

const PAGE_SIZE = 12;

interface FolderEntry {
  id: string;
  slug: string;
  label: string;
  linkCount: number;
  createdAt: string;
}

export function FoldersIndex() {
  const router = useRouter();
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch("/api/admin/folders");
      if (!res.ok) throw new Error("Failed to load folders");
      const data = await res.json();
      setFolders(data.folders);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load folders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(folders.length / PAGE_SIZE));
  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [page, totalPages]);

  const pageItems = folders.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div>
      <div className="row-between page-head">
        <div>
          <h1>Photos</h1>
          <p className="muted" style={{ margin: 0 }}>
            Folders collect photos; share a link to receive uploads.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
          + New folder
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : folders.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No folders yet. Click <strong>New folder</strong> to create one and
            get a shareable upload link.
          </p>
        </div>
      ) : (
        <>
          <div className="folder-list">
            {pageItems.map((f) => (
              <Link key={f.id} href={`/admin/photos/${f.slug}`} className="folder-row">
                <span className="folder-row-icon" aria-hidden>
                  🗂
                </span>
                <span className="folder-row-main">
                  <strong>{f.label}</strong>
                  <span className="small muted mono">{f.slug}/</span>
                </span>
                <span className="folder-row-meta small muted">
                  {f.linkCount} link{f.linkCount === 1 ? "" : "s"} ·{" "}
                  {new Date(f.createdAt).toLocaleDateString()}
                </span>
                <span className="folder-row-chevron" aria-hidden>
                  ›
                </span>
              </Link>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="row-between pager">
              <span className="muted small">
                Page {page + 1} of {totalPages} · {folders.length} folders
              </span>
              <div className="row">
                <button
                  className="btn btn-sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  ← Previous
                </button>
                <button
                  className="btn btn-sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {modalOpen && (
        <NewFolderModal
          onClose={() => setModalOpen(false)}
          onCreated={(slug) => router.push(`/admin/photos/${slug}`)}
        />
      )}
    </div>
  );
}

function NewFolderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: name.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to create folder");
      }
      const { folder } = await res.json();
      onCreated(folder.slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create folder");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal-card modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 style={{ margin: 0 }}>New folder</h2>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={submit}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="folder-name">Folder name</label>
            <input
              id="folder-name"
              className="input"
              placeholder="e.g. Jim's wedding"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <span className="small muted" style={{ minHeight: "1.1em" }}>
              {name.trim() ? (
                <>
                  Stored in <span className="mono">{slugify(name)}/</span>
                </>
              ) : (
                " "
              )}
            </span>
          </div>

          <div className="row" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create folder"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
