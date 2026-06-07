import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { loginSchema } from "@/lib/validation";
import { handle, badRequest, unauthorized, json } from "@/lib/http";

export const runtime = "nodejs";

// Best-effort in-memory brute-force throttle: max N failed attempts per IP per
// window. Good enough for a single instance; a multi-instance deploy should use
// a shared store (Redis) for this to be effective across replicas.
const MAX_FAILURES = 10;
const WINDOW_MS = 5 * 60_000;
const failures = new Map<string, number[]>();

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : "").trim() || "unknown";
}
function recentFailures(ip: string): number {
  const now = Date.now();
  const list = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list.length;
}
function recordFailure(ip: string) {
  const list = failures.get(ip) ?? [];
  list.push(Date.now());
  failures.set(ip, list);
}

export const POST = handle(async (req: NextRequest) => {
  const ip = clientIp(req);
  if (recentFailures(ip) >= MAX_FAILURES) {
    return json(
      { error: "Too many attempts. Try again later." },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("Invalid credentials payload");
  }

  const { username, password } = parsed.data;

  const rows = await db
    .select()
    .from(admins)
    .where(eq(admins.username, username))
    .limit(1);

  const admin = rows[0];

  // Always run a bcrypt comparison to avoid leaking whether the user exists via
  // response timing.
  const hash = admin?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await bcrypt.compare(password, hash);

  if (!admin || !ok) {
    recordFailure(ip);
    return unauthorized("Invalid username or password");
  }

  failures.delete(ip);
  const token = await createSessionToken({
    id: admin.id,
    username: admin.username,
  });

  const res = NextResponse.json({ ok: true, username: admin.username });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
});
