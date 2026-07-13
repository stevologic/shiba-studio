import type { Metadata } from "next";
import { Geist, Geist_Mono, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { THEME_IDENTITY } from "@/lib/theme";
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

export const metadata: Metadata = {
  title: THEME_IDENTITY.metadataTitle,
  description: THEME_IDENTITY.metadataDescription,
  icons: {
    icon: THEME_IDENTITY.logoPath,
  },
};

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
