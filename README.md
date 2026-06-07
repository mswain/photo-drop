# Photo Drop

A dead-simple photo **upload** app — not a gallery. Admins create photo
**folders** and share no-login upload **links**; anyone with a link can
batch-upload photos from their phone. Files go **directly from the browser to
S3** via presigned URLs — they never pass through the web app.

- **Next.js** (App Router) + TypeScript
- **Postgres + Drizzle** for admins, folders, and share links
- **Folders & links**: a folder is a named collection (an S3 prefix); each
  folder can have **many share links**, each with its own expiry / cap / active
  state. Any of a folder's links uploads into the same place.
- **S3 is the single source of truth for files** — no per-file rows, no stored
  filenames. Object keys are GUIDs under the folder's slug:
  `<slug>/<guid>.<ext>` (a folder named "Jim's wedding" → `jims-wedding/…`).
  Set `S3_KEY_PREFIX` to nest everything under a root (e.g. `uploads/`).
- **Preview thumbnails** are generated on demand the first time a photo is
  previewed (sharp, plus a WebAssembly libheif decoder so iPhone **HEIC/HEIF**
  previews work too) and cached in a sibling `<slug>-thumbnails/` folder with the
  same filename — so no thumbnail state is tracked in the DB either.
- Deployable as a single **Docker** container

## How it works

```
Admin ─login─▶ /admin/photos ─create folder─▶ folder (slug) + share link (token)
                                                  │
Visitor ─────────▶ /u/<token>  (no auth, simple web form)
                       │ 1. POST /api/upload/<token>/presign  (metadata only)
                       │ 2. PUT file ─────────────────────────▶  S3  (direct)
                       ▼
Admin ─▶ folder view ─▶ browse photos (S3 ListObjectsV2, paginated)
                     ├─▶ select + bulk download (presigned S3 GETs, direct)
                     └─▶ manage links (add / regenerate / expiry / cap / delete)
```

The app server only ever sees file **metadata** (content-type + size) to sign an
upload URL. The bytes go straight to S3.

## Environment variables

Copy `.env.example` to `.env` and fill it in.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Postgres connection string. |
| `SESSION_SECRET` | ✅ | Secret for signing admin session cookies. `openssl rand -base64 48`. |
| `AWS_ACCESS_KEY_ID` | ✅ | AWS key with S3 access to the bucket. |
| `AWS_SECRET_ACCESS_KEY` | ✅ | AWS secret. |
| `AWS_REGION` | ✅ | Bucket region (default `us-east-1`). |
| `S3_BUCKET` | ✅ | Target bucket name. |
| `S3_ENDPOINT` | — | For S3-compatible storage (MinIO, R2). Omit for AWS. |
| `S3_FORCE_PATH_STYLE` | — | `true` for MinIO/path-style endpoints. |
| `S3_KEY_PREFIX` | — | Namespace prepended to all keys (default empty = bucket root; e.g. `uploads/`). |
| `MAX_UPLOAD_BYTES` | — | Per-file size limit (default 50 MiB). |
| `ALLOWED_CONTENT_TYPE_PREFIX` | — | Allowed content-type prefix (default `image/`). |
| `PRESIGN_EXPIRY_SECONDS` | — | Presigned URL lifetime (default 900). |
| `THUMBNAIL_MAX_PX` | — | Longest edge of generated preview thumbnails (default 600). |

## AWS setup

### 1. Bucket CORS (required for direct browser uploads)

Without this, the browser `PUT` to S3 is blocked. In the bucket's
**Permissions → CORS**:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedOrigins": ["https://your-app-domain.example"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Use your real origin in production; `"*"` is fine only for local testing.

### 2. IAM policy for the access key

Keep the bucket **private** (Block Public Access on). Downloads work via
presigned GET URLs, so the bucket never needs to be public.

By default, link folders live at the bucket root, so the policy below grants
access to the whole bucket. If you set `S3_KEY_PREFIX` (e.g. `uploads/`),
replace `*` with `uploads/*` and `["*"]` with `["uploads/*"]` to scope it down.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["*"] } }
    }
  ]
}
```

## Local development

This project uses **pnpm** (so dependencies are shared via pnpm's global
store). With Corepack you don't even need pnpm installed globally —
`corepack enable` picks up the version pinned in `package.json`.

### Quick start (recommended)

The Makefile spins up the whole dev stack — a [MiniStack](https://ministack.org)
S3 emulator and a Postgres container — and runs the app on the host. Everything
needed (bucket, migrations, a dev admin) is provisioned automatically.

```bash
corepack enable        # one-time; uses the pinned pnpm version
pnpm install
make dev               # http://localhost:3000  ·  admin / devpassword
```

`make dev` starts infra, waits for it, creates the bucket, migrates, seeds the
dev admin, then runs `pnpm dev`. Press Ctrl-C to stop the app; `make down` stops
the infra (keeps the DB volume), `make clean` wipes it. `make help` lists all
targets. The dev stack is wired up by the exported variables at the top of the
Makefile (MiniStack S3 at `:4566` with `test`/`test`, Postgres at `:5433`); no
bucket CORS is needed because MiniStack is permissive in dev.

### Manual setup

If you'd rather not use the Makefile (e.g. you have your own Postgres/S3):

```bash
pnpm install
cp .env.example .env          # then edit values
pnpm db:generate              # creates SQL in ./drizzle (commit this)
pnpm db:migrate
pnpm run create-admin myusername 'a-strong-password'
pnpm dev                      # http://localhost:3000
```

`pnpm db:push` is a quick alternative to generate+migrate during early dev.

## Running with Docker

The image runs migrations on startup, then serves the app.

```bash
# Build
docker build -t photo-drop .

# Run (point DATABASE_URL at a reachable Postgres)
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://user:pass@host:5432/photodrop \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -e AWS_ACCESS_KEY_ID=... \
  -e AWS_SECRET_ACCESS_KEY=... \
  -e AWS_REGION=us-east-1 \
  -e S3_BUCKET=my-photo-drop-bucket \
  photo-drop
```

Create the first admin against the same database (one-off):

```bash
pnpm run create-admin myusername 'a-strong-password'   # from a source checkout
```

> The slim runtime image doesn't bundle the `create-admin` tooling. Create
> admins from a source checkout (`pnpm run create-admin`) pointed at the same
> `DATABASE_URL`, or insert a bcrypt hash into the `admins` table directly.

### Or the whole stack

```bash
# Provide SESSION_SECRET, AWS creds, and S3_BUCKET via .env first.
docker compose up --build
```

## Admin usage

1. Sign in at `/login`.
2. **Photos** — the home screen. Create a **folder** (named after what you're
   collecting). Each folder gets an initial share link automatically.
3. **Folder view** — open a folder to:
   - **Share links**: copy/open the upload URL, **regenerate** it (invalidates
     the old URL), change **settings** (expiry, max-photo cap, note), enable/
     disable, **delete**, or **+ Add link** for more links into the same folder.
   - **Photos**: browse files (paginated straight from S3). **Preview** opens a
     card with an on-demand thumbnail (generated + cached in S3 on first view),
     plus **View full size**, **Download**, and **Delete**. Tick the checkboxes
     to **bulk-download** the selected photos — straight from S3, not via the app.
     Use ← / → or arrow keys to move between previews.
4. **Admin users** (last nav item) — list admins and **create** new ones; delete
   any except yourself and the last remaining admin.

Deleting a folder stops its links from working; the uploaded photos remain in S3
(the source of truth) and reappear if a folder with the same slug is recreated.

## Security notes

- The bucket should stay private; all access is via short-lived presigned URLs.
- Restrict CORS `AllowedOrigins` to your domain in production.
- The presign endpoint is public (by design) but constrained: the link must be
  active/unexpired, uploads are image-only (no SVG) and size-capped, and an
  optional per-link photo cap is enforced. Consider a CDN/WAF rate limit in
  front of it for abuse resistance.
- **Sessions**: HTTP-only, `Secure` (prod), `SameSite=Lax` cookies, signed JWTs
  that are re-validated against the DB every request (a deleted admin's session
  stops working). Login is bcrypt'd with a constant-time compare and a basic
  per-IP rate limit (use a shared store for multi-instance).
- **CSRF**: SameSite=Lax is the primary defense; middleware additionally rejects
  cross-origin mutations to `/api/admin` and `/api/auth` (Origin vs Host).
- **XSS**: a per-request nonce-based **Content-Security-Policy** (set in
  middleware) plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, and `Referrer-Policy`. Uploaded originals are always
  served as **attachments** (never inline), so a hostile stored content-type
  can't execute; the inline preview is the re-encoded thumbnail. The login
  redirect (`?next=`) only allows same-site relative paths (no open redirect).
- Serve over HTTPS (required for `Secure` cookies and the CSP upgrade rule).

## Project layout

```
src/
  db/            schema (admins, folders, upload_links), connection, migrator
  lib/           env, auth/session, s3 helpers, ids (keys/slug/thumb),
                 slug, thumbnail (sharp), validation
  middleware.ts  gate /admin + /api/admin
  app/
    theme-toggle.tsx       light/dark toggle (system-detected)
    login/                 admin sign-in
    admin/                 redirects to /admin/photos
    admin/photos/          folders index (create folder)
    admin/photos/[slug]/   folder: share links + photo browser + previews
    admin/users/           manage / create admins
    u/[token]/             public upload form
    api/
      auth/                          login / logout
      admin/folders/                 list / create folders
      admin/folders/[slug]/          delete folder
      admin/folders/[slug]/links/    list / add links for a folder
      admin/links/[id]/              update / delete a link
      admin/links/[id]/regenerate/   issue a fresh token
      admin/users/                   list / create / delete admins
      admin/photos/                  list / delete / download / download-urls
      admin/photos/thumbnail/        on-demand thumbnail (generate + cache)
      upload/[token]/                presign (public, direct-to-S3)
scripts/create-admin.ts    create/update an admin (CLI; also doable in the UI)
```
