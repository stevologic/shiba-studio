import { Suspense } from 'react';
import ShibaStudio from '@/components/shiba-studio';
import ErrorBoundary from '@/components/error-boundary';
import { isKnownAppPath } from '@/lib/app-navigation';
import { notFound } from 'next/navigation';

/**
 * App shell lives in the segment layout so it does NOT remount when the URL
 * changes between /chat/:idA and /chat/:idB (or any other tab path).
 * Page remounts were re-running loadAll/loadNavStats and flashing left-nav badges.
 */
export default async function AppSectionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ section?: string[] }>;
}) {
  const { section = [] } = await params;
  if (!isKnownAppPath(`/${section.join('/')}`)) notFound();
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <ShibaStudio />
      </Suspense>
      {/* Page slot kept for App Router; shell owns all UI. */}
      {children}
    </ErrorBoundary>
  );
}
