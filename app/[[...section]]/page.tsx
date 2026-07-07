import { Suspense } from 'react';
import GrokDesk from '@/components/grok-desk';
import ErrorBoundary from '@/components/error-boundary';

export default function AppPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <GrokDesk />
      </Suspense>
    </ErrorBoundary>
  );
}