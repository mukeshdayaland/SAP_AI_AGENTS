'use client';

import { Check, ChevronDown, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { translateServer, useT } from '@/lib/i18n';
import type { StepView } from '@/lib/use-chat';
import { cx, Spinner } from '../ui/primitives';

/**
 * Operational progress — never model reasoning. Rendered like a BTP solution
 * diagram path: numbered markers joined by connectors whose line style carries
 * meaning (solid = direct/synchronous call, dashed = awaiting an asynchronous
 * human confirmation, dotted = optional/skipped), with a legend.
 */

const marker: Record<StepView['state'], string> = {
  running: 'border-brand bg-surface text-brand',
  done: 'border-brand bg-brand text-on-brand',
  error: 'border-error bg-error text-on-brand',
  pending_confirmation: 'border-warning bg-warning-soft text-warning',
  skipped: 'border-line-strong bg-surface text-ink-3',
};

const connector: Record<StepView['state'], string> = {
  running: 'border-solid border-brand/40',
  done: 'border-solid border-brand',
  error: 'border-solid border-error',
  pending_confirmation: 'border-dashed border-warning',
  skipped: 'border-dotted border-line-strong',
};

function Legend() {
  const t = useT();
  const item = (style: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cx('inline-block w-5 border-t-2', style)} />
      {label}
    </span>
  );
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 ps-8 text-[10px] text-ink-3" aria-label={t('status.legend')}>
      {item('border-solid border-brand', t('status.direct'))}
      {item('border-dashed border-warning', t('status.awaiting'))}
      {item('border-dotted border-line-strong', t('status.skipped'))}
    </p>
  );
}

export function ExecutionStatus({ steps, streaming, durationMs }: { steps: StepView[]; streaming: boolean; durationMs?: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const visible = steps.filter((s) => s.id !== 'understand' || streaming);
  if (!visible.length && !streaming) return null;
  // Platform steps (understanding, composing, a hand-over between agents) are not SAP calls.
  const toolCount = steps.filter((s) => s.id !== 'understand' && !s.id.startsWith('compose') && !s.id.startsWith('handoff')).length;
  const current = [...visible].reverse().find((s) => s.state === 'running');
  const failed = steps.filter((s) => s.state === 'error');
  const denied = failed.filter((s) => s.denied).length;
  // The header says what happened: a failed or denied call is never shown as a success.
  const outcome = !toolCount
    ? t('status.completed')
    : !failed.length
      ? t('status.used', { count: toolCount })
      : `${denied === failed.length ? t('status.notAllowedCount', { count: denied }) : t('status.failedCount', { count: failed.length })}${failed.length < toolCount ? ` · ${t('status.succeededCount', { count: toolCount - failed.length })}` : ''}`;
  const summary = streaming ? (current ? translateServer(current.label) : t('status.working')) : `${outcome}${durationMs ? ` · ${t('status.seconds', { seconds: (durationMs / 1000).toFixed(1) })}` : ''}`;
  const showLegend = visible.some((s) => s.state === 'pending_confirmation' || s.state === 'skipped');

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-2 transition-colors hover:border-brand/50 hover:text-ink"
      >
        {streaming ? <Spinner className="text-brand" /> : failed.length ? <TriangleAlert size={13} className="text-warning" aria-hidden /> : <Check size={13} className="text-success" aria-hidden />}
        <span aria-live="polite">{summary}</span>
        {visible.length > 0 && <ChevronDown size={13} aria-hidden className={cx('transition-transform', open && 'rotate-180')} />}
      </button>
      {open && visible.length > 0 && (
        <>
          <ol className="mt-3 text-[12px]">
            {visible.map((s, i) => {
              const last = i === visible.length - 1;
              return (
                <li key={s.id} className="relative flex gap-3 pb-3 last:pb-0">
                  {!last && <span aria-hidden className={cx('absolute start-[11px] top-6 bottom-0 border-s-2', connector[visible[i + 1]!.state])} />}
                  <span
                    className={cx('relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold tabular-nums', marker[s.state])}
                    aria-label={t('status.step', { n: i + 1, state: t(`status.state.${s.state}`) })}
                  >
                    {s.state === 'running' ? <Spinner className="h-3 w-3" /> : i + 1}
                  </span>
                  <span className={cx('pt-0.5', s.state === 'error' ? 'text-error' : s.state === 'skipped' ? 'text-ink-3' : 'text-ink-2')}>
                    {translateServer(s.label)}
                    {s.state === 'error' && t(s.denied ? 'status.notAllowed' : 'status.failed')}
                    {s.state === 'pending_confirmation' && <span className="font-semibold text-warning">{t('status.awaitingYou')}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          {showLegend && <Legend />}
        </>
      )}
    </div>
  );
}
