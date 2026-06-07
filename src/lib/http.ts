import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError } from "./session";
import { SESSION_COOKIE, clearSessionCookieOptions } from "./auth";

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

export function notFound(message = "Not found") {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function unauthorized(message = "Unauthorized") {
  const res = NextResponse.json({ error: message }, { status: 401 });
  // Drop a stale/invalid session cookie so the client recovers cleanly
  // (re-login) instead of looping on a token middleware still considers valid.
  res.cookies.set(SESSION_COOKIE, "", clearSessionCookieOptions());
  return res;
}

/**
 * Wraps a route handler, translating known errors into JSON responses so each
 * handler can simply throw on bad input / missing auth.
 */
export function handle<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response> | Response,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return unauthorized();
      }
      if (err instanceof ZodError) {
        return badRequest("Invalid request", err.flatten());
      }
      console.error("Unhandled route error:", err);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 },
      );
    }
  };
}
