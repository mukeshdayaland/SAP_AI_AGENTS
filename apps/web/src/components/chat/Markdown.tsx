'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { safeHref } from '@/lib/format';

/**
 * Renders model output as Markdown under a strict policy:
 * - raw HTML is dropped (`skipHtml`), never parsed or executed;
 * - only http(s)/mailto links survive, opened with noopener/noreferrer;
 * - images are never loaded (a classic data-exfiltration channel) — the
 *   alt text and URL are shown instead.
 */
const components: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href);
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img: ({ alt, src }) => (
    <span className="text-ink-3">
      [image: {alt || 'untitled'}
      {typeof src === 'string' && safeHref(src) ? ` — ${safeHref(src)}` : ''}]
    </span>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

export default function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      components={components}
      urlTransform={(url) => safeHref(url) ?? ''}
    >
      {text}
    </ReactMarkdown>
  );
}
