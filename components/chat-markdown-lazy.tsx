'use client';

// Defers the markdown pipeline (react-markdown + remark-gfm + highlight.js)
// out of the first-load bundle. While the chunk streams in, the message text
// renders as plain pre-wrapped content, so nothing is ever hidden.

import React, { Suspense, lazy } from 'react';

const ChatMarkdownInner = lazy(() => import('./chat-markdown'));

interface ChatMarkdownLazyProps {
  content: string;
  className?: string;
}

export default function ChatMarkdown({ content, className = '' }: ChatMarkdownLazyProps) {
  return (
    <Suspense fallback={<div className={`chat-md whitespace-pre-wrap ${className}`}>{content}</div>}>
      <ChatMarkdownInner content={content} className={className} />
    </Suspense>
  );
}
