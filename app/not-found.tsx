import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen bg-background text-foreground grid place-items-center p-6">
      <section className="grok-card max-w-lg p-6 text-center">
        <div className="font-mono text-xs text-dim">404</div>
        <h1 className="text-xl font-semibold mt-2">That Shiba Studio page does not exist</h1>
        <p className="text-sm text-dim mt-2">Use the dashboard to get back to your agents and work.</p>
        <Link href="/" className="grok-btn grok-btn-primary mt-4 inline-flex">Open dashboard</Link>
      </section>
    </main>
  );
}
