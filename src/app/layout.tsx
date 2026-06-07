import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Photo Dump",
  description: "Simple, direct-to-S3 photo uploads.",
};

// Runs before paint to set the theme (stored choice, else OS preference),
// avoiding a flash of the wrong theme.
const themeScript = `(function(){try{var t=localStorage.getItem('pd-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Browsers blank the nonce attribute in the DOM, so suppress the
            resulting (harmless) hydration attribute mismatch. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        {children}
      </body>
    </html>
  );
}
