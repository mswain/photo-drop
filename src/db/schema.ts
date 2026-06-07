import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";

/**
 * The database stores admin accounts, photo folders, and the shareable upload
 * links that point at them. Uploaded files themselves live exclusively in S3 —
 * S3 is the single source of truth for files. We never record filenames here.
 */

/** Admins are the only authenticated users. */
export const admins = pgTable("admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A photo folder — a named collection backed by an S3 prefix. The `slug` is the
 * human-readable, unique S3 directory derived from the name at creation
 * (e.g. "jims-wedding"); it is immutable. Files live under "<slug>/".
 */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    label: text("label").notNull(),
    createdBy: uuid("created_by").references(() => admins.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("folders_slug_idx").on(t.slug)],
);

/**
 * A shareable, no-auth upload link into a folder. A folder can have many links
 * (e.g. one per audience), each with its own expiry / cap / active state. The
 * `token` is the unguessable id in /u/<token>; uploads land in the folder's
 * slug directory regardless of which link was used.
 */
export const uploadLinks = pgTable(
  "upload_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    // Optional note describing this particular link.
    label: text("label"),
    isActive: boolean("is_active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUploads: integer("max_uploads"),
    createdBy: uuid("created_by").references(() => admins.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("upload_links_folder_id_idx").on(t.folderId),
    index("upload_links_token_idx").on(t.token),
  ],
);

export type Admin = typeof admins.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type UploadLink = typeof uploadLinks.$inferSelect;
