import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { THEME_IDENTITY } from "@/lib/theme";
import { BRAND_THEME_COLOR } from "@/lib/brand";
import { configuredPublicOrigin } from "@/lib/public-origin";
import { PrivilegedHostBoundary } from "@/components/privileged-host-boundary";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

/** Readable traditional monospace for the Studio Terminal (not pixel/CRT). */
const terminalFont = IBM_Plex_Mono({
  variable: "--font-terminal",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const viewport: Viewport = {
  themeColor: BRAND_THEME_COLOR,
  colorScheme: 'dark',
};

/**
 * Icons and the share card come from the app/ metadata file conventions
 * (favicon.ico, icon.svg, apple-icon.png, opengraph-image.png, twitter-image.png),
 * all rendered from lib/brand.ts by `npm run generate:brand`. Declaring them
 * here too would only emit duplicate <link>/<meta> tags.
 */
export function generateMetadata(): Metadata {
  // Unfurled links need absolute URLs. Prefer the operator's reverse-proxy
  // origin; otherwise fall back to the loopback origin Studio serves on, which
  // keeps `next build` from erroring on the relative canonical below.
  const publicOrigin = configuredPublicOrigin();
  const metadataBase = publicOrigin ?? new URL(`http://localhost:${process.env.PORT || 3000}`);

  return {
    metadataBase,
    title: THEME_IDENTITY.metadataTitle,
    description: THEME_IDENTITY.metadataDescription,
    applicationName: THEME_IDENTITY.brandName,
    manifest: '/manifest.webmanifest',
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      url: '/',
      siteName: THEME_IDENTITY.brandName,
      title: THEME_IDENTITY.metadataTitle,
      description: THEME_IDENTITY.metadataDescription,
    },
    twitter: {
      card: 'summary_large_image',
      title: THEME_IDENTITY.metadataTitle,
      description: THEME_IDENTITY.metadataDescription,
    },
    // Brands the label under the iOS home-screen icon. `capable` stays off so
    // the shortcut opens in Safari — a standalone window breaks the OAuth
    // redirects and downloads Studio relies on.
    appleWebApp: {
      capable: false,
      title: THEME_IDENTITY.brandName,
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${terminalFont.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-shell text-primary">
        {children}
        {/* Privileged hosts survive normal navigation but never mount in Companion. */}
        <PrivilegedHostBoundary />
        <Toaster
          position="bottom-left"
          theme="dark"
          closeButton
          expand={false}
          visibleToasts={4}
          gap={8}
          offset={{ bottom: '11.5rem', left: '0.55rem' }}
          className="studio-toaster"
          toastOptions={{
            className: 'studio-toast',
            duration: 3800,
          }}
        />
      </body>
    </html>
  );
}
