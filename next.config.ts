import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained build so the Docker image stays small and
  // does not need the full node_modules tree at runtime.
  output: "standalone",
  // Keep these out of the webpack server bundle. The `postgres` driver in
  // particular relies on raw Node sockets and misbehaves when bundled
  // (connections hang / time out); the AWS SDK is large and meant to be
  // loaded as a normal dependency.
  serverExternalPackages: [
    "postgres",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "sharp",
    "heic-convert",
    "libheif-js",
  ],
  // sharp loads a platform-specific native binary, and heic-convert loads a
  // libheif WASM blob, both via runtime-computed paths the standalone tracer
  // can miss. Force their files into the build output so the Docker runtime
  // image can resize (and HEIC-decode) images.
  outputFileTracingIncludes: {
    "/api/admin/photos/thumbnail": [
      "./node_modules/sharp/**/*",
      "./node_modules/@img/**/*",
      "./node_modules/heic-convert/**/*",
      "./node_modules/libheif-js/**/*",
    ],
  },
  eslint: {
    // Linting is run separately (pnpm lint); don't block production builds.
    ignoreDuringBuilds: true,
  },
  // Static security headers for every response. The (per-request, nonce-based)
  // Content-Security-Policy is set in middleware.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "geolocation=(), microphone=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
