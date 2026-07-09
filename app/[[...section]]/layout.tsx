import { Suspense } from 'react';
import ShibaStudio from '@/components/shiba-studio';
import ErrorBoundary from '@/components/error-boundary';

/**
 * App shell lives in the segment layout so it does NOT remount when the URL
 * changes between /chat/:idA and /chat/:idB (or any other tab path).
 * Page remounts were re-running loadAll/loadNavStats and flashing left-nav badges.
 */
export default function AppSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
