'use client';

import type { DeploymentEnvironment } from '@prowess/contracts';
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

/* ------------------------------ Logo ------------------------------ */

/** Prowess mark: an ascending facet "P" with a spark — original artwork. */
export function ProwessMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="var(--brand-primary)" />
      <path d="M10 24V8.5h7.2c3.7 0 6.3 2.3 6.3 5.6 0 3.4-2.6 5.7-6.3 5.7H13.6V24H10Z" fill="var(--on-brand)" />
      <path d="M13.6 11.6v5.1h3.3c1.7 0 2.8-1 2.8-2.55s-1.1-2.55-2.8-2.55h-3.3Z" fill="var(--brand-primary)" />
      <circle cx="24" cy="24" r="2.6" fill="var(--brand-secondary-soft)" />
    </svg>
  );
}

/* ------------------------------ Buttons ------------------------------ */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }>(
  function Button({ variant = 'secondary', size = 'md', className, ...props }, ref) {
    return (
      <button
        ref={ref}
        {...props}
        className={cx(
          'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' ? 'h-8 px-3 text-[12px]' : 'h-10 px-4 text-sm',
          variant === 'primary' && 'bg-brand text-on-brand hover:bg-brand-hover',
          variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-muted',
          variant === 'ghost' && 'text-ink-2 hover:bg-muted hover:text-ink',
          variant === 'danger' && 'bg-error text-bg hover:opacity-90',
          className,
        )}
      />
    );
  },
);

/** Icon-only button. `label` is required: it becomes the accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }>(
  function IconButton({ label, active, className, children, ...props }, ref) {
    return (
      <Tooltip label={label} side="bottom">
        <button
          ref={ref}
          type="button"
          aria-label={label}
          {...props}
          className={cx(
            'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-muted hover:text-ink disabled:opacity-40',
            active && 'bg-muted text-ink',
            className,
          )}
        >
          {children}
        </button>
      </Tooltip>
    );
  },
);

/* ------------------------------ Tooltip ------------------------------ */

/** Accessible tooltip: shown on hover and keyboard focus, dismissed with Escape. */
export function Tooltip({ label, children, side = 'top' }: { label: string; children: ReactNode; side?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cx(
            'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-elevated px-2 py-1 text-xs font-medium text-ink-2 shadow-lift',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}

/* ------------------------------ Badges ------------------------------ */

export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'critical' | 'info';

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border border-current/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        tone === 'neutral' && 'bg-muted text-ink-2',
        tone === 'brand' && 'bg-brand-soft text-brand',
        tone === 'success' && 'bg-success-soft text-success',
        tone === 'warning' && 'bg-warning-soft text-warning',
        tone === 'critical' && 'bg-error-soft text-error',
        tone === 'info' && 'bg-info-soft text-info',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EnvironmentBadge({ env }: { env: DeploymentEnvironment }) {
  const tone: Tone = env === 'PROD' ? 'critical' : env === 'QA' ? 'warning' : 'info';
  return (
    <Badge tone={tone} className="normal-case tracking-normal">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {env === 'PROD' ? 'Production' : env === 'QA' ? 'Quality' : 'Development'}
    </Badge>
  );
}

/* ------------------------------ Dialog ------------------------------ */

/** Native <dialog>: focus trapping, Escape and inert background come from the platform. */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-area border border-line bg-elevated p-0 text-ink shadow-lift backdrop:bg-black/40', wide ? 'max-w-3xl' : 'max-w-md')}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-ink-3 hover:bg-muted hover:text-ink" aria-label="Close dialog">
          Esc
        </button>
      </div>
      <div className="px-5 py-4">{children}</div>
    </dialog>
  );
}

/* ------------------------------ Menu ------------------------------ */

/** Minimal accessible popover menu (button + role=menu, Escape/outside click closes). */
export function Menu({
  trigger,
  label,
  children,
  align = 'right',
  side = 'bottom',
  triggerClassName = 'inline-flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-muted',
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  side?: 'top' | 'bottom';
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
            if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
          }}
          className={cx('absolute z-40 min-w-56 rounded-area border border-line bg-elevated p-1.5 shadow-lift', side === 'top' ? 'bottom-full mb-1' : 'mt-1', align === 'right' ? 'right-0' : 'left-0')}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onSelect, danger, href }: { children: ReactNode; onSelect?: () => void; danger?: boolean; href?: string }) {
  const cls = cx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none', danger ? 'text-error' : 'text-ink');
  return href ? (
    <a role="menuitem" href={href} className={cls}>
      {children}
    </a>
  ) : (
    <button role="menuitem" type="button" onClick={onSelect} className={cls}>
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cx('inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />;
}
