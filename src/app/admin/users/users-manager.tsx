"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-fetch";

interface AdminUser {
  id: string;
  username: string;
  createdAt: string;
}

export function UsersManager({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed to load admins");
      const data = await res.json();
      setUsers(data.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load admins");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to create admin");
      }
      setUsername("");
      setPassword("");
      load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create admin");
    } finally {
      setCreating(false);
    }
  }

  async function remove(user: AdminUser) {
    if (!confirm(`Delete admin "${user.username}"?`)) return;
    try {
      const res = await apiFetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Delete failed");
      }
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div>
      <h1>Admin users</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Anyone listed here can sign in and manage everything.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <h2>New admin</h2>
        {createError && <div className="alert alert-error">{createError}</div>}
        <form onSubmit={create}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 180, marginBottom: 0 }}>
              <label htmlFor="new-username">Username</label>
              <input
                id="new-username"
                className="input"
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 180, marginBottom: 0 }}>
              <label htmlFor="new-password">Password</label>
              <input
                id="new-password"
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create admin"}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        {loading ? (
          <p className="muted" style={{ margin: 0 }}>
            Loading…
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Added</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.username}</strong>
                      {u.id === currentUserId && (
                        <span className="badge badge-inactive" style={{ marginLeft: "0.5rem" }}>
                          you
                        </span>
                      )}
                    </td>
                    <td className="muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td className="col-actions">
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={u.id === currentUserId}
                        title={u.id === currentUserId ? "You can't delete yourself" : undefined}
                        onClick={() => remove(u)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
