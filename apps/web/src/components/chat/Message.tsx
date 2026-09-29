'use client';

import type { ConfirmationRequest, MessageDTO } from '@prowess/contracts';
import { Check, Copy, Database, FileText, RefreshCw, ThumbsDown, ThumbsUp, Wrench } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { formatDateTime, formatTime } from '@/lib/format';
import type { ChatMessage } from '@/lib/use-chat';
import { SapComponent } from '../sap/cards';
import { useAsk } from '../sap/card';
import { Badge, IconButton, ProwessMark, cx } from '../ui/primitives';
import { ConfirmationCard } from './ConfirmationCard';
import { ExecutionStatus } from './ExecutionStatus';

// Markdown + syntax highlighting are loaded lazily to keep the initial bundle small.
const Markdown = dynamic(() => import('./Markdown'), { ssr: false, loading: () => null });

export function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-soft px-4 py-2.5 text-[15px] text-ink" title={formatDateTime(message.createdAt)}>
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
        {message.attachments && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {message.attachments.map((a) => (
              <li key={a.id} className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-xs text-ink-2">
                <FileText size={12} aria-hidden /> {a.fileName}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function AssistantMessage({
  message,
  isLast,
  technical,
  agentName,
  onRegenerate,
  onRate,
  onConfirmation,
}: {
  message: ChatMessage;
  isLast: boolean;
  technical: boolean;
  agentName: string;
  onRegenerate: () => void;
  onRate: (rating: 'up' | 'down') => void;
  onConfirmation: (c: ConfirmationRequest, m?: MessageDTO) => void;
}) {
  const [copied, setCopied] = useState(false);
  const ask = useAsk();
  const streaming = message.status === 'streaming';
  const mock = message.sources.some((s) => s.mock) || message.execution?.tools.some((t) => t.mock);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <article className="flex gap-3" aria-label={`${agentName} response`} aria-busy={streaming}>
      <ProwessMark size={28} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-xs text-ink-3">
          <span className="font-semibold text-ink-2">{agentName}</span>
          {!streaming && <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>}
          {mock && <Badge tone="warning">Mock data</Badge>}
        </div>

        <ExecutionStatus steps={message.steps} streaming={streaming} {...(message.execution && { durationMs: message.execution.durationMs })} />

        {message.components.length > 0 && (
          <div className="my-3 space-y-3">
            {message.components.map((c, i) => (
              <SapComponent key={i} component={c} />
            ))}
          </div>
        )}

        {message.content && (
          <div className={cx('prose-prowess text-ink', streaming && 'streaming-caret')}>
            <Markdown text={message.content} />
          </div>
        )}
        {streaming && !message.content && !message.components.length && <p className="streaming-caret text-sm text-ink-3" aria-label="Generating" />}

        {message.confirmations.length > 0 && (
          <div className="my-3 space-y-3">
            {message.confirmations.map((c) => (
              <ConfirmationCard key={c.id} confirmation={c} onResolved={onConfirmation} />
            ))}
          </div>
        )}

        {message.error && (
          <div role="alert" className="mt-2 rounded-xl border border-error/30 bg-error-soft px-4 py-3 text-sm">
            <p className="text-ink">{message.error.message}</p>
            {message.error.reference && (
              <p className="mt-1 text-xs text-ink-2">
                Reference: <span className="font-mono">{message.error.reference}</span>
              </p>
            )}
          </div>
        )}

        {!streaming && message.actions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested follow-ups">
            {message.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => ask(a.prompt)}
                className="rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-ink-2 transition-colors hover:border-brand hover:text-brand"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}

        {!streaming && message.sources.length > 0 && (
          <details className="mt-3 rounded-lg border border-line bg-surface text-[13px]">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-ink-2 hover:text-ink">
              <Database size={13} aria-hidden /> Sources ({message.sources.length})
            </summary>
            <ul className="divide-y divide-line border-t border-line">
              {message.sources.map((s) => (
                <li key={s.id} className="grid grid-cols-1 gap-x-4 gap-y-0.5 px-3 py-2 sm:grid-cols-[1fr_auto]">
                  <span className="text-ink">
                    <span className="font-medium">{s.mock ? 'Mock S/4HANA' : 'SAP S/4HANA'}</span> · {s.system} · {s.objectType} <span className="font-mono">{s.objectId}</span>
                  </span>
                  <span className="text-ink-3">
                    Retrieved {formatDateTime(s.retrievedAt)} · {s.agent}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {!streaming && technical && message.execution && (
          <details className="mt-2 rounded-lg border border-dashed border-line text-xs">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-ink-3 hover:text-ink-2">
              <Wrench size={12} aria-hidden /> Technical details
            </summary>
            <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 border-t border-dashed border-line px-3 py-2 font-mono text-ink-2">
              <dt className="text-ink-3">Agent</dt>
              <dd>{message.execution.agent}</dd>
              <dt className="text-ink-3">Model tier</dt>
              <dd>{message.execution.modelTier}</dd>
              {message.execution.provider && (
                <>
                  <dt className="text-ink-3">Provider</dt>
                  <dd>
                    {message.execution.provider} · {message.execution.model}
                  </dd>
                </>
              )}
              {message.execution.usage && (
                <>
                  <dt className="text-ink-3">Tokens</dt>
                  <dd>
                    {message.execution.usage.inputTokens} in / {message.execution.usage.outputTokens} out
                  </dd>
                </>
              )}
              <dt className="text-ink-3">Duration</dt>
              <dd>{message.execution.durationMs} ms</dd>
              <dt className="text-ink-3">Correlation ID</dt>
              <dd className="break-all">{message.execution.correlationId}</dd>
              {message.execution.tools.map((t) => (
                <div key={t.id} className="col-span-2 mt-1 rounded border border-line px-2 py-1">
                  {t.tool} · {t.system} · {t.durationMs} ms · {t.status} · {t.risk}
                </div>
              ))}
            </dl>
          </details>
        )}

        {!streaming && (
          <div className="mt-1.5 flex items-center gap-0.5">
            {message.content && (
              <IconButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </IconButton>
            )}
            {isLast && (
              <IconButton label={message.status === 'error' ? 'Retry' : 'Regenerate'} onClick={onRegenerate}>
                <RefreshCw size={15} />
              </IconButton>
            )}
            {message.status !== 'error' && !message.id.startsWith('__') && (
              <>
                <IconButton label="Helpful" active={message.feedback === 'up'} onClick={() => onRate('up')} aria-pressed={message.feedback === 'up'}>
                  <ThumbsUp size={15} />
                </IconButton>
                <IconButton label="Not helpful" active={message.feedback === 'down'} onClick={() => onRate('down')} aria-pressed={message.feedback === 'down'}>
                  <ThumbsDown size={15} />
                </IconButton>
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
