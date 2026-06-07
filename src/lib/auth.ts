import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/**
 * Stateless admin sessions backed by a signed JWT in an HTTP-only cookie.
 * This module is intentionally edge-runtime safe (no Node-only APIs, no
 * bcrypt) so it can be used from middleware as well as route handlers.
 */

export const SESSION_COOKIE = "pd_session";
const ALG = "HS256";
const SESSION_TTL = "7d";

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload extends JWTPayload {
  sub: string; // admin id
  username: string;
}

export async function createSessionToken(admin: {
  id: string;
  username: string;
}): Promise<string> {
  return new SignJWT({ username: admin.username })
    .setProtectedHeader({ alg: ALG })
    .setSubject(admin.id)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secretKey());
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify<SessionPayload>(token, secretKey());
    if (!payload.sub || !payload.username) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Cookie options for the session cookie. `secure` is enabled in production. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days, matches SESSION_TTL
  };
}
