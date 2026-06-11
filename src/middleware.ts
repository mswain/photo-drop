import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/** Origin of the configured S3 endpoint, if any (dev MinIO/MiniStack uses http). */
function s3Origin(): string {
  const ep = process.env.S3_ENDPOINT;
  if (!ep) return "";
  try {
    return new URL(ep).origin;
  } catch {
    return "";
  }
}

/**
 * Exact origin the browser hits for presigned S3 URLs — needed for frame-src,
 * which (unlike img-src/connect-src) doesn't get a blanket `https:` and so must
 * name the bucket origin precisely. With a custom endpoint this is the endpoint
 * itself (path-style) or the bucket-prefixed host (virtual-hosted style); on
 * AWS proper it's the regional virtual-hosted bucket URL.
 */
function s3DownloadOrigin(): string {
  const bucket = process.env.S3_BUCKET;
  const ep = process.env.S3_ENDPOINT;
  if (ep) {
    try {
      const u = new URL(ep);
      if (process.env.S3_FORCE_PATH_STYLE !== "true" && bucket) {
        u.host = `${bucket}.${u.host}`;
      }
      return u.origin;
    } catch {
      return "";
    }
  }
  if (!bucket) return "";
  const region = process.env.AWS_REGION || "us-east-1";
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

/**
 * Per-request Content-Security-Policy. Scripts are locked to same-origin plus a
 * fresh nonce (Next.js applies it to its own inline bootstrap scripts; we apply
 * it to our theme script). Inline styles are allowed because the UI uses inline
 * `style` attributes. Images/uploads talk to S3, so those origins are allowed.
 */
function buildCsp(nonce: string): string {
  const prod = process.env.NODE_ENV === "production";
  const s3 = s3Origin();
  const extra = s3 ? ` ${s3}` : "";
  const frameS3 = s3DownloadOrigin();
  // Next.js dev (HMR / React Refresh) needs eval + inline scripts; production
  // gets the strict nonce-based policy.
  const scriptSrc = prod
    ? `script-src 'self' 'nonce-${nonce}'`
    : `script-src 'self' 'unsafe-eval' 'unsafe-inline'`;
  const directives = [
    `default-src 'self'`,
    scriptSrc,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:${extra}`,
    // Videos are played inline in a <video> element straight from S3. Without
    // its own directive, media falls back to default-src ('self') and the
    // cross-origin S3 load is blocked ("Media load rejected by URL safety
    // check"), so mirror img-src here.
    `media-src 'self' data: blob: https:${extra}`,
    `font-src 'self'`,
    `connect-src 'self' https:${extra}${prod ? "" : " ws: wss:"}`,
    // Batch downloads load presigned S3 URLs in hidden iframes (see
    // triggerDownloads); without this, frame-src falls back to default-src
    // ('self') and every frame is blocked.
    `frame-src 'self'${frameS3 ? ` ${frameS3}` : ""}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (prod) {
    directives.push("upgrade-insecure-requests");
  }
  return directives.join("; ");
}

/**
 * Defense-in-depth CSRF check: a present Origin header must match the request
 * host. (SameSite=Lax cookies are the primary defense; this mirrors what
 * Next.js Server Actions do.) Absent Origin (non-browser clients, same-origin
 * GETs) is allowed.
 */
function originAllowed(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1) Block cross-origin mutations to sensitive endpoints.
  const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  const sensitive =
    pathname.startsWith("/api/admin") || pathname.startsWith("/api/auth");
  if (isMutation && sensitive && !originAllowed(req)) {
    return NextResponse.json(
      { error: "Cross-origin request blocked" },
      { status: 403 },
    );
  }

  // 2) Per-request CSP nonce, threaded to the app (layout) via a request header.
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const withCsp = (res: NextResponse) => {
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  // 3) Auth gating for the admin area.
  const isAdminApi = pathname.startsWith("/api/admin");
  const isAdminPage = pathname.startsWith("/admin");
  const needsAuthCheck = isAdminApi || isAdminPage || pathname === "/login";
  const session = needsAuthCheck
    ? await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)
    : null;

  if ((isAdminApi || isAdminPage) && !session) {
    if (isAdminApi) {
      return withCsp(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?next=${encodeURIComponent(pathname)}`;
    return withCsp(NextResponse.redirect(loginUrl));
  }

  if (pathname === "/login" && session) {
    const adminUrl = req.nextUrl.clone();
    adminUrl.pathname = "/admin";
    adminUrl.search = "";
    return withCsp(NextResponse.redirect(adminUrl));
  }

  return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
