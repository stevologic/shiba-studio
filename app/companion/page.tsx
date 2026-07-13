import type { Metadata } from 'next';
import { CompanionApp } from '@/components/companion-app';

export const metadata: Metadata = {
  title: 'Shiba Companion',
  description: 'Scoped remote supervision for Shiba Studio tasks and Attention.',
  manifest: '/companion/manifest.webmanifest',
  robots: { index: false, follow: false },
};

export default function CompanionPage() {
  return <CompanionApp />;
}
