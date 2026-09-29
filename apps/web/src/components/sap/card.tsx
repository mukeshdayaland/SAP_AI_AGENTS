'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Badge, cx, type Tone } from '../ui/primitives';

/** Lets cards offer follow-up prompts (e.g. "Analyze vendor") without knowing about chat state. */
export const AskContext = createContext<(prompt: string) => void>(() => undefined);
export const useAsk = () => useContext(AskContext);

export function SapCard({
  kind,
  id,
  status,
  children,
  actions,
  icon,
}: {
  kind: string;
  id: string;
  status?: { label: string; tone: Tone };
  children: ReactNode;
  actions?: { label: string; prompt: string }[];
  icon?: ReactNode;
}) {
  const ask = useAsk();
  return (
    <section aria-label={`${kind} ${id}`} className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {icon && <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">{icon}</span>}
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{kind}</p>
            <p className="truncate font-mono text-[15px] font-semibold text-ink">{id}</p>
          </div>
        </div>
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
      </header>
      <div className="px-4 py-3">{children}</div>
      {actions && actions.length > 0 && (
        <footer className="flex flex-wrap gap-2 border-t border-line bg-muted/40 px-4 py-2.5">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => ask(a.prompt)}
              className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-2 transition-colors hover:border-brand hover:text-brand"
            >
              {a.label}
            </button>
          ))}
        </footer>
      )}
    </section>
  );
}

export function Fields({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <dl className={cx('grid gap-x-6 gap-y-2.5', cols === 3 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2')}>{children}</dl>;
}

export function Field({ label, children, mono, emphasize }: { label: string; children: ReactNode; mono?: boolean; emphasize?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className={cx('truncate text-sm text-ink', mono && 'font-mono', emphasize && 'text-base font-semibold')}>{children}</dd>
    </div>
  );
}

export const toneText: Record<Tone, string> = {
  neutral: 'text-ink',
  brand: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  critical: 'text-error',
  info: 'text-info',
};
