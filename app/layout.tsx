import type { Metadata } from "next";
import { Geist, Geist_Mono, VT323 } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { THEME_IDENTITY } from "@/lib/theme";
import StudioTerminalHost from "@/components/studio-terminal-host";

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

/** Classic CRT / green-screen terminal face for the Studio Terminal. */
const terminalFont = VT323({
  variable: "--font-terminal",
  subsets: ["latin"],
  weight: "400",
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
        {/* Terminal lives in the root layout so navigations do not remount the PTY UI. */}
        <StudioTerminalHost />
        <Toaster position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
