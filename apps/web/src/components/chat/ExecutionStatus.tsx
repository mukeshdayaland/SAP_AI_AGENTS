'use client';

import { Check, ChevronDown, Clock, X } from 'lucide-react';
import { useState } from 'react';
import type { StepView } from '@/lib/use-chat';
import { cx, Spinner } from '../ui/primitives';

/**
 * Operational progress — never model reasoning. Shows "Working…" while
 * streaming and a compact summary afterwards; both expand to the step list.
 */
export function ExecutionStatus({ steps, streaming, durationMs }: { steps: StepView[]; streaming: boolean; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const visible = steps.filter((s) => s.id !== 'understand' || streaming);
  if (!visible.length && !streaming) return null;
  const toolCount = steps.filter((s) => s.id !== 'understand' && !s.id.startsWith('compose')).length;
  const current = [...visible].reverse().find((s) => s.state === 'running');
  const summary = streaming
    ? (current?.label ?? 'Working…')
    : `${toolCount ? `Used ${toolCount} SAP ${toolCount === 1 ? 'tool' : 'tools'}` : 'Completed'}${durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : ''}`;

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-2 transition-colors hover:text-ink"
      >
        {streaming ? <Spinner className="text-brand" /> : <Check size={13} className="text-success" aria-hidden />}
        <span aria-live="polite">{summary}</span>
        {visible.length > 0 && <ChevronDown size={13} aria-hidden className={cx('transition-transform', open && 'rotate-180')} />}
      </button>
      {open && visible.length > 0 && (
        <ol className="mt-2 space-y-1.5 border-l border-line pl-4 text-[13px]">
          {visible.map((s) => (
            <li key={s.id} className="flex items-start gap-2">
              <span className="mt-0.5">
                {s.state === 'running' && <Spinner className="text-brand" />}
                {s.state === 'done' && <Check size={14} className="text-success" aria-label="done" />}
                {s.state === 'error' && <X size={14} className="text-error" aria-label="failed" />}
                {s.state === 'pending_confirmation' && <Clock size={14} className="text-warning" aria-label="awaiting confirmation" />}
                {s.state === 'skipped' && <X size={14} className="text-ink-3" aria-label="skipped" />}
              </span>
              <span className={cx(s.state === 'error' ? 'text-error' : 'text-ink-2')}>
                {s.label}
                {s.state === 'pending_confirmation' && ' — awaiting your confirmation'}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
