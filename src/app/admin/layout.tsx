import Link from "next/link";
import { getSession } from "@/lib/session";
import { LogoutButton } from "./logout-button";
import { ThemeToggle } from "../theme-toggle";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  return (
    <div>
      <nav className="nav">
        <div className="nav-inner">
          <Link href="/admin/photos" className="nav-brand">
            Photo Drop
          </Link>
          <div className="nav-links">
            <Link href="/admin/photos">Photos</Link>
            <Link href="/admin/users">Admin users</Link>
          </div>
          <div className="nav-spacer" />
          {session && (
            <span className="muted small">{session.username}</span>
          )}
          <ThemeToggle />
          <LogoutButton />
        </div>
      </nav>
      <main className="container">{children}</main>
    </div>
  );
}
