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
    // SAP-sourced data is drawn as an "SAP area" (BTP diagram guideline): blue outline,
    // filled header, unfilled body — nested areas alternate fill / no fill.
    <section aria-label={`${kind} ${id}`} className="overflow-hidden rounded-area border border-area-sap/60 bg-surface shadow-soft">
      <header className="flex items-start justify-between gap-3 border-b border-area-sap/25 bg-area-sap-fill px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {icon && <IconCircle>{icon}</IconCircle>}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{kind}</p>
            <p className="truncate font-mono text-[14px] font-semibold text-ink">{id}</p>
          </div>
        </div>
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
      </header>
      <div className="px-4 py-3">{children}</div>
      {actions && actions.length > 0 && (
        <footer className="flex flex-wrap gap-2 border-t border-line px-4 py-2.5">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => ask(a.prompt)}
              className="rounded-lg border border-brand/40 bg-surface px-2.5 py-1 text-xs font-semibold text-brand transition-colors hover:bg-brand-soft"
            >
              {a.label}
            </button>
          ))}
        </footer>
      )}
    </section>
  );
}

/** Service-icon treatment from the guideline: icon on a neutral grey background circle. */
export function IconCircle({ children, size = 'md' }: { children: ReactNode; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex shrink-0 items-center justify-center rounded-full border border-line bg-area-nonsap-fill text-brand',
        size === 'sm' ? 'h-7 w-7' : 'h-9 w-9',
      )}
    >
      {children}
    </span>
  );
}

/** Area wrapper for SAP-derived tables, KPIs and timelines. */
export function SapArea({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="rounded-area border border-area-sap/60 bg-surface p-4 shadow-soft">
      <h4 className="mb-3 text-[12px] font-bold text-ink">{label}</h4>
      {children}
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
