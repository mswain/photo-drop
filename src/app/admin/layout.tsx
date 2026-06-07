import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LogoutButton } from "./logout-button";
import { ThemeToggle } from "../theme-toggle";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Middleware gates on a valid JWT, but can't hit the DB. Re-check here so a
  // valid token for a since-deleted admin is sent back to login, not shown the
  // shell. (APIs already 401 via requireSession.)
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div>
      <nav className="nav">
        <div className="nav-inner">
          <Link href="/admin/photos" className="nav-brand">
            <span className="nav-brand-text">Photo Drop</span>
          </Link>
          <div className="nav-links">
            <Link href="/admin/photos">Photos</Link>
            <Link href="/admin/users">Admin users</Link>
          </div>
          <div className="nav-spacer" />
          <span className="muted small nav-user">{session.username}</span>
          <ThemeToggle />
          <LogoutButton />
        </div>
      </nav>
      <main className="container">{children}</main>
    </div>
  );
}
