'use client';

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground grid place-items-center p-6">
      <section className="grok-card max-w-lg p-6 text-center" role="alert">
        <h1 className="text-xl font-semibold">Shiba Studio hit an unexpected error</h1>
        <p className="text-sm text-dim mt-2">
          Retry the current page. If it happens again, check Logs for the matching error
          {error.digest ? ` (${error.digest})` : ''}.
        </p>
        <button type="button" className="grok-btn grok-btn-primary mt-4" onClick={unstable_retry}>
          Try again
        </button>
      </section>
    </main>
  );
}
