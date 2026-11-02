'use client';

import type { ConfirmationRequest, MessageDTO } from '@prowess/contracts';
import { Check, Copy, FileText, RefreshCw, ThumbsDown, ThumbsUp, Wrench, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { formatDateTime, formatTime } from '@/lib/format';
import { translateServer, useT } from '@/lib/i18n';
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
      <div className="max-w-[min(85%,48rem)] rounded-2xl rounded-ee-md border border-area-nonsap/25 bg-area-nonsap-fill px-4 py-2.5 text-[14px] text-ink" title={formatDateTime(message.createdAt)}>
        <p dir="auto" className="whitespace-pre-wrap break-words">
          {message.content}
        </p>
        {message.attachments && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {message.attachments.map((a) => (
              <li key={a.id} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-xs text-ink-2">
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
  onShowDetails,
  detailsShown,
}: {
  message: ChatMessage;
  isLast: boolean;
  technical: boolean;
  agentName: string;
  onRegenerate: () => void;
  onRate: (rating: 'up' | 'down') => void;
  onConfirmation: (c: ConfirmationRequest, messages?: MessageDTO[]) => void;
  /** On wide screens the details show in the context panel; otherwise they open over the page. */
  onShowDetails?: () => void;
  detailsShown?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [details, setDetails] = useState(false);
  const ask = useAsk();
  const streaming = message.status === 'streaming';
  const mock = message.sources.some((s) => s.mock) || message.execution?.tools.some((t) => t.mock);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <article className="flex gap-3" aria-label={t('message.response', { agent: agentName })} aria-busy={streaming}>
      <ProwessMark size={28} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-xs text-ink-3">
          <span className="font-semibold text-ink-2">{agentName}</span>
          {!streaming && <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>}
          {mock && <Badge tone="warning">{t('message.mock')}</Badge>}
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
          <div className={cx('prose-prowess max-w-3xl text-ink', streaming && 'streaming-caret')}>
            <Markdown text={streaming ? message.content : translateServer(message.content)} />
          </div>
        )}
        {streaming && !message.content && !message.components.length && <p className="streaming-caret text-sm text-ink-3" aria-label={t('message.generating')} />}

        {message.confirmations.length > 0 && (
          <div className="my-3 space-y-3">
            {message.confirmations.map((c) => (
              <ConfirmationCard key={c.id} confirmation={c} onResolved={onConfirmation} />
            ))}
          </div>
        )}

        {message.error && (
          <div role="alert" className="mt-2 rounded-area border border-error/60 bg-error-soft px-4 py-3 text-sm">
            <p className="text-ink">{translateServer(message.error.message)}</p>
            {message.error.reference && (
              <p className="mt-1 text-xs text-ink-2">
                {t('common.referenceLabel')}: <span className="font-mono">{message.error.reference}</span>
              </p>
            )}
          </div>
        )}

        {!streaming && message.actions.length > 0 && (
          <div className="mt-3 flex max-w-3xl flex-wrap gap-2" aria-label={t('message.followUps')}>
            {message.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => ask(a.prompt)}
                className="rounded-full border border-brand/40 bg-surface px-3 py-1 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft"
              >
                {translateServer(a.label)}
              </button>
            ))}
          </div>
        )}

        {!streaming && (
          <div className="mt-1.5 flex items-center gap-0.5">
            {message.content && (
              <IconButton label={t(copied ? 'common.copied' : 'common.copy')} onClick={copy}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </IconButton>
            )}
            {isLast && (
              <IconButton label={t(message.status === 'error' ? 'message.retry' : 'message.regenerate')} onClick={onRegenerate}>
                <RefreshCw size={15} />
              </IconButton>
            )}
            {technical && message.execution && (
              <IconButton label={t('workspace.technical')} active={detailsShown ?? details} onClick={() => (onShowDetails ? onShowDetails() : setDetails(true))} {...(!onShowDetails && { 'aria-haspopup': 'dialog' as const })}>
                <Wrench size={15} />
              </IconButton>
            )}
            {message.status !== 'error' && !message.id.startsWith('__') && (
              <>
                <IconButton label={t('message.helpful')} active={message.feedback === 'up'} onClick={() => onRate('up')} aria-pressed={message.feedback === 'up'}>
                  <ThumbsUp size={15} />
                </IconButton>
                <IconButton label={t('message.notHelpful')} active={message.feedback === 'down'} onClick={() => onRate('down')} aria-pressed={message.feedback === 'down'}>
                  <ThumbsDown size={15} />
                </IconButton>
              </>
            )}
          </div>
        )}
        {details && message.execution && <TechnicalDetails execution={message.execution} onClose={() => setDetails(false)} />}
      </div>
    </article>
  );
}

/** How a response was produced: agent, model, tokens, duration and the SAP tool calls. */
export function TechnicalDetailsList({ execution }: { execution: NonNullable<ChatMessage['execution']> }) {
  const t = useT();
  return (
    <dl className="space-y-2 font-mono text-[10px] leading-snug text-ink-2">
      {(
        [
          [t('tech.agent'), execution.agent],
          [t('tech.tier'), execution.modelTier],
          ...(execution.provider ? [[t('tech.provider'), `${execution.provider} · ${execution.model}`]] : []),
          ...(execution.usage ? [[t('tech.tokens'), t('tech.tokensValue', { input: execution.usage.inputTokens, output: execution.usage.outputTokens })]] : []),
          [t('tech.duration'), t('tech.ms', { ms: execution.durationMs })],
          [t('tech.correlation'), execution.correlationId],
        ] as [string, string][]
      ).map(([label, value]) => (
        <div key={label}>
          <dt className="text-ink-3">{label}</dt>
          <dd className="break-all text-ink">{value}</dd>
        </div>
      ))}
      {execution.tools.length > 0 && (
        <div>
          <dt className="text-ink-3">{t('tech.tools')}</dt>
          {execution.tools.map((call) => (
            <dd key={call.id} className="mt-1 rounded border border-line px-2 py-1">
              <span className="block break-all text-ink">{call.tool}</span>
              {call.system} · {t('tech.ms', { ms: call.durationMs })} · {call.status} · {call.risk}
            </dd>
          ))}
        </div>
      )}
    </dl>
  );
}

/** Panel over the right edge with the technical details, for screens without the context panel. */
function TechnicalDetails({ execution, onClose }: { execution: NonNullable<ChatMessage['execution']>; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-label={t('workspace.technical')} className="fixed inset-y-0 end-0 z-50 flex w-[272px] max-w-[85vw] flex-col border-s border-line bg-surface shadow-lift">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Wrench size={14} aria-hidden /> {t('workspace.technical')}
          </h2>
          <IconButton label={t('common.close')} onClick={onClose} autoFocus>
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <TechnicalDetailsList execution={execution} />
        </div>
      </aside>
    </>
  );
}
