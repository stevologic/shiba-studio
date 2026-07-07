'use client';

// App-level error boundary — a crash in any panel shows a branded recovery
// screen instead of white-screening the whole studio (C2 in the critical review).

import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('GrokDesk crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="app-root flex h-screen items-center justify-center p-6">
        <div className="modal max-w-md w-full p-6 text-center">
          <div className="text-3xl mb-2" aria-hidden>🛰️</div>
          <div className="text-lg font-semibold">Something broke in this panel</div>
          <div className="text-xs text-muted mt-2 leading-relaxed">
            The rest of your data is safe — chats, agents, and settings live on disk.
            Try again, or reload the app.
          </div>
          <pre className="text-[10px] text-error font-mono text-left mt-4 p-3 bg-black/40 rounded max-h-32 overflow-auto whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2.5 mt-5">
            <button
              type="button"
              className="grok-btn grok-btn-secondary flex-1"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              type="button"
              className="grok-btn grok-btn-primary flex-1"
              onClick={() => window.location.reload()}
            >
              Reload GrokDesk
            </button>
          </div>
        </div>
      </div>
    );
  }
}
