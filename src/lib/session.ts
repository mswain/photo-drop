import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { SESSION_COOKIE, verifySessionToken, type SessionPayload } from "./auth";

/**
 * Server-side (Node runtime) helpers for reading the current admin session
 * inside route handlers and server components. Kept separate from auth.ts so
 * that auth.ts stays import-light for the edge middleware.
 */

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = await verifySessionToken(token);
  if (!payload) return null;

  // The JWT can be validly signed yet point at an admin that no longer exists
  // (deleted account, or a reset database). Treat that as logged out so we
  // never act — or write foreign keys — as a ghost admin.
  const [admin] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(eq(admins.id, payload.sub))
    .limit(1);
  if (!admin) return null;

  return payload;
}

/** Returns the session or throws a 401-style error for use in route handlers. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {
    throw new UnauthorizedError();
  }
  return session;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
