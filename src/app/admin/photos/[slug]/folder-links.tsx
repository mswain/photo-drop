"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-fetch";

interface ShareLink {
  id: string;
  token: string;
  label: string | null;
  isActive: boolean;
  expiresAt: string | null;
  maxUploads: number | null;
  createdAt: string;
}

function isExpired(l: ShareLink) {
  return l.expiresAt != null && new Date(l.expiresAt).getTime() < Date.now();
}
function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInputValue(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function FolderLinks({ slug }: { slug: string }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [origin, setOrigin] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => setOrigin(window.location.origin), []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/folders/${slug}/links`);
      if (!res.ok) throw new Error("Failed to load links");
      const data = await res.json();
      setLinks(data.links);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load links");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function addLink() {
    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/folders/${slug}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Failed to add link");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add link");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="card">
      <div className="row-between">
        <span className="muted small">
          Anyone with an active link can upload to this folder.
        </span>
        <button className="btn btn-sm btn-primary" onClick={addLink} disabled={adding}>
          {adding ? "Adding…" : "+ Add link"}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
          {error}
        </div>
      )}

      {loading ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          Loading…
        </p>
      ) : links.length === 0 ? (
        <p className="muted small" style={{ marginBottom: 0 }}>
          No links yet. Add one to share this folder for uploads.
        </p>
      ) : (
        <div style={{ marginTop: "0.95rem", display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          {links.map((link) => (
            <LinkRow key={link.id} link={link} origin={origin} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function LinkRow({
  link,
  origin,
  onChanged,
}: {
  link: ShareLink;
  origin: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shareUrl = origin ? `${origin}/u/${link.token}` : `/u/${link.token}`;
  const expired = isExpired(link);

  async function call(method: string, path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Action failed");
      }
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
      setBusy(false);
    }
  }

  function regenerate() {
    if (!confirm("Regenerate this link? The current URL will stop working.")) return;
    call("POST", `/api/admin/links/${link.id}/regenerate`);
  }
  function remove() {
    if (!confirm("Delete this link? Its URL will stop working.")) return;
    call("DELETE", `/api/admin/links/${link.id}`);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "11px", padding: "0.85rem" }}>
      <div className="row-between">
        <div className="row">
          {expired ? (
            <span className="badge badge-expired">Expired</span>
          ) : link.isActive ? (
            <span className="badge badge-active">Active</span>
          ) : (
            <span className="badge badge-inactive">Disabled</span>
          )}
          {link.label && <span className="small muted">{link.label}</span>}
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => call("PATCH", `/api/admin/links/${link.id}`, { isActive: !link.isActive })}
          >
            {link.isActive ? "Disable" : "Enable"}
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={regenerate}>
            Regenerate
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => setEditing((v) => !v)}>
            {editing ? "Close" : "Settings"}
          </button>
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={remove}>
            Delete
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
          {error}
        </div>
      )}

      <div className="row" style={{ marginTop: "0.7rem", flexWrap: "nowrap" }}>
        <input className="input mono input-sm" style={{ width: "100%" }} readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
        <button className="btn btn-sm" onClick={copy}>
          {copied ? "Copied!" : "Copy"}
        </button>
        <a className="btn btn-sm" href={shareUrl} target="_blank" rel="noreferrer">
          Open
        </a>
      </div>

      <div className="small muted" style={{ marginTop: "0.55rem" }}>
        {link.expiresAt ? `Expires ${new Date(link.expiresAt).toLocaleString()}` : "No expiry"}
        {" · "}
        {link.maxUploads != null ? `Max ${link.maxUploads} photos` : "Unlimited"}
        {" · "}
        Created {new Date(link.createdAt).toLocaleDateString()}
      </div>

      {editing && (
        <EditLinkForm
          link={link}
          busy={busy}
          onSave={(body) => call("PATCH", `/api/admin/links/${link.id}`, body)}
        />
      )}
    </div>
  );
}

function EditLinkForm({
  link,
  busy,
  onSave,
}: {
  link: ShareLink;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [label, setLabel] = useState(link.label ?? "");
  const [expiresAt, setExpiresAt] = useState(toLocalInputValue(link.expiresAt));
  const [maxUploads, setMaxUploads] = useState(link.maxUploads != null ? String(link.maxUploads) : "");

  function save(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      label,
      expiresAt: expiresAt ? fromLocalInputValue(expiresAt) : "",
      maxUploads: maxUploads ? Number(maxUploads) : "",
    });
  }

  return (
    <form onSubmit={save} style={{ marginTop: "0.85rem", borderTop: "1px solid var(--border)", paddingTop: "0.85rem" }}>
      <div className="field">
        <label>Note (optional)</label>
        <input className="input input-sm" style={{ width: "100%" }} placeholder="e.g. for the family" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label>Expires</label>
          <input className="input input-sm" style={{ width: "100%" }} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
        <div className="field" style={{ width: 170 }}>
          <label>Max photos</label>
          <input className="input input-sm" style={{ width: "100%" }} type="number" min={1} placeholder="Unlimited" value={maxUploads} onChange={(e) => setMaxUploads(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}
