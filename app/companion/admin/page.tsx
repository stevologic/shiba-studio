import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { CompanionAdmin } from '@/components/companion-admin';
import { isLoopbackHostname } from '@/lib/companion-auth';

export const metadata: Metadata = {
  title: 'Companion access · Shiba Studio',
  robots: { index: false, follow: false },
};

export default async function CompanionAdminPage() {
  const requestHeaders = await headers();
  const host = requestHeaders.get('host') || '';
  let hostname = '';
  try { hostname = new URL(`http://${host}`).hostname; } catch { /* invalid host */ }
  if (!isLoopbackHostname(hostname)) notFound();
  const port = (() => { try { return new URL(`http://${host}`).port; } catch { return ''; } })();
  const protocol = requestHeaders.get('x-forwarded-proto') === 'https' ? 'https:' : 'http:';
  return <CompanionAdmin defaultOrigin={`${protocol}//shiba.local${port ? `:${port}` : ''}`} />;
}
