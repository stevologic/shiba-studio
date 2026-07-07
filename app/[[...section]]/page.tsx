import { Suspense } from 'react';
import ShibaStudio from '@/components/shiba-studio';
import ErrorBoundary from '@/components/error-boundary';

export default function AppPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <ShibaStudio />
      </Suspense>
    </ErrorBoundary>
  );
}