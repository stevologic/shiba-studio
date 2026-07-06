import { Suspense } from 'react';
import GrokDesk from '@/components/grok-desk';

export default function AppPage() {
  return (
    <Suspense fallback={null}>
      <GrokDesk />
    </Suspense>
  );
}