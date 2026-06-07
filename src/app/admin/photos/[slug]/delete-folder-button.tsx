"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client-fetch";

/**
 * Danger button + confirmation modal for soft-deleting a folder. The user must
 * type the folder's name exactly to enable the action; on success the folder's
 * S3 objects are archived (not erased) server-side and we return to the index.
 */
export function DeleteFolderButton({
  slug,
  confirmName,
}: {
  slug: string;
  confirmName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="btn btn-sm btn-danger" onClick={() => setOpen(true)}>
        Delete folder
      </button>
      {open && (
        <DeleteFolderModal
          slug={slug}
          confirmName={confirmName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DeleteFolderModal({
  slug,
  confirmName,
  onClose,
}: {
  slug: string;
  confirmName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim() === confirmName;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/folders/${slug}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to delete folder");
      }
      router.push("/admin/photos");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete folder");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal-card modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 style={{ margin: 0 }}>Delete folder</h2>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <p className="muted" style={{ marginTop: 0 }}>
          This removes the folder and its share links. The photos aren&apos;t
          erased — they&apos;re moved to an archive in storage and can be
          recovered if needed.
        </p>

        <form onSubmit={submit}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="confirm-name">
              Type <strong>{confirmName}</strong> to confirm
            </label>
            <input
              id="confirm-name"
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </div>

          <div className="row" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-danger"
              disabled={busy || !matches}
            >
              {busy ? "Deleting…" : "Delete folder"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
