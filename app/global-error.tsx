'use client';

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', background: '#000', color: '#f5f5f5', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
          <section style={{ maxWidth: 560, padding: 28, textAlign: 'center', border: '1px solid #333', borderRadius: 16, background: '#0a0a0a' }} role="alert">
            <h1 style={{ margin: 0, fontSize: 22 }}>Shiba Studio could not load</h1>
            <p style={{ color: '#a3a3a3', lineHeight: 1.6 }}>
              Retry the app{error.digest ? ` (error ${error.digest})` : ''}.
            </p>
            <button type="button" onClick={unstable_retry} style={{ border: '1px solid #555', borderRadius: 8, background: '#f5f5f5', color: '#000', padding: '9px 14px', cursor: 'pointer' }}>
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
