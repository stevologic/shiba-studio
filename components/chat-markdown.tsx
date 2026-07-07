'use client';

import React, { memo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

function languageFromChildren(children: React.ReactNode): string | null {
  let lang: string | null = null;
  React.Children.forEach(children, (child) => {
    if (!lang && React.isValidElement(child)) {
      const cls = (child.props as { className?: string }).className || '';
      const m = cls.match(/language-([\w+-]+)/);
      if (m) lang = m[1];
    }
  });
  return lang;
}

function CodeBlock({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const lang = languageFromChildren(children);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(extractText(children).replace(/\n$/, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="chat-md-codeblock">
      <div className="chat-md-codeblock-bar">
        <span className="chat-md-codeblock-lang">{lang || 'code'}</span>
        <button type="button" className="chat-md-codeblock-copy" onClick={copyCode} title="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS = {
  pre: CodeBlock,
  a: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="chat-md-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
};

interface ChatMarkdownProps {
  content: string;
  className?: string;
}

/** Default sanitizer strips data: URIs — allow inline data-URI images so the
 *  agent tool loop can embed live browser screenshots in replies. */
function urlTransform(url: string): string {
  return url.startsWith('data:image/') ? url : defaultUrlTransform(url);
}

/** Markdown renderer for chat messages — GFM tables/lists, highlighted code with copy buttons. */
function ChatMarkdownInner({ content, className = '' }: ChatMarkdownProps) {
  return (
    <div className={`chat-md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={MARKDOWN_COMPONENTS}
        urlTransform={urlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

const ChatMarkdown = memo(
  ChatMarkdownInner,
  (prev, next) => prev.content === next.content && prev.className === next.className,
);

export default ChatMarkdown;
