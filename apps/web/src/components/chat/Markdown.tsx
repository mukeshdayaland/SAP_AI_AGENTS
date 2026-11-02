'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { safeHref } from '@/lib/format';
import { getLocale, translate } from '@/lib/i18n';

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
      {translate(getLocale(), 'markdown.image', { alt: alt || translate(getLocale(), 'markdown.untitled') })}
      {typeof src === 'string' && safeHref(src) ? ` — ${safeHref(src)}` : ''}
    </span>
  ),
  // Each block sets its own direction from its first strong letter, so an Arabic answer reads right to left
  // and an English one left to right whatever the interface language.
  p: ({ children }) => <p dir="auto">{children}</p>,
  li: ({ children }) => <li dir="auto">{children}</li>,
  h1: ({ children }) => <h1 dir="auto">{children}</h1>,
  h2: ({ children }) => <h2 dir="auto">{children}</h2>,
  h3: ({ children }) => <h3 dir="auto">{children}</h3>,
  blockquote: ({ children }) => <blockquote dir="auto">{children}</blockquote>,
  td: ({ children }) => <td dir="auto">{children}</td>,
  th: ({ children }) => <th dir="auto">{children}</th>,
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
