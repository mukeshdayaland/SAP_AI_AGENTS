'use client';

import type { UIComponent } from '@prowess/contracts';
import { BriefcaseBusiness, CalendarDays, ChevronUp, ClipboardCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatDate, humanize } from '@/lib/format';
import { isMessageKey, translateServer, useT, type T } from '@/lib/i18n';
import { Badge, cx, type Tone } from '../ui/primitives';
import { Field, Fields, IconCircle, useAsk, useShowMore } from './card';

/** Entries a list shows before "Show more". */
const PREVIEW = { absences: 5, members: 8, approvals: 5 } as const;

type Of<K extends UIComponent['type']> = Extract<UIComponent, { type: K }>['data'];

const sapLabel = (t: T, code: string) => {
  const key = `sap.${code}`;
  return isMessageKey(key) ? t(key) : humanize(code);
};

const FRAME = 'overflow-hidden rounded-area border border-area-sap/60 bg-surface shadow-soft';
const HEADER = 'flex items-center gap-3 border-b border-area-sap/25 bg-area-sap-fill px-4 py-3';
const ACTION = 'rounded-lg border border-brand/40 bg-surface px-2.5 py-1 text-xs font-semibold text-brand transition-colors hover:bg-brand-soft';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .filter((_, i, all) => i === 0 || i === all.length - 1)
    .join('');

/** Initials on a neutral circle. No photo is loaded: a card shows only what the tool returned. */
function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cx('flex shrink-0 items-center justify-center rounded-full border border-line bg-brand-soft font-semibold text-brand', size === 'sm' ? 'h-8 w-8 text-[11px]' : 'h-11 w-11 text-sm')}
    >
      {initials(name)}
    </span>
  );
}

/** "4 years 5 months" since the hire date. */
function tenure(t: T, hireDate: string | undefined, now = new Date()): string | undefined {
  const start = hireDate ? new Date(`${hireDate}T00:00:00Z`) : undefined;
  if (!start || Number.isNaN(start.getTime()) || start > now) return undefined;
  const months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth() - (now.getUTCDate() < start.getUTCDate() ? 1 : 0);
  const years = Math.floor(months / 12);
  return [years ? t('hr.years', { count: years }) : '', months % 12 ? t('hr.months', { count: months % 12 }) : ''].filter(Boolean).join(' ') || t('hr.lessThanMonth');
}

function Actions({ items }: { items: { label: string; prompt: string }[] }) {
  const ask = useAsk();
  return (
    <footer className="flex flex-wrap gap-2 border-t border-line px-4 py-2.5">
      {items.map((a) => (
        <button key={a.label} type="button" onClick={() => ask(a.prompt)} className={ACTION}>
          {a.label}
        </button>
      ))}
    </footer>
  );
}

function PersonLine({ name, detail, aside }: { name: string; detail?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Avatar name={name} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{name}</p>
        {detail && <p className="truncate text-[12px] text-ink-2">{detail}</p>}
      </div>
      {aside}
    </div>
  );
}

const roleOf = (p: { jobTitle?: string; location?: string; department?: string }) => [p.jobTitle, p.location ?? p.department].filter(Boolean).join(' · ') || undefined;

export function EmployeeCard({ data }: { data: Of<'employee'> }) {
  const t = useT();
  const since = tenure(t, data.hireDate);
  return (
    <section aria-label={t('hr.employee', { id: data.userId })} className={FRAME}>
      <header className={HEADER}>
        <Avatar name={data.displayName} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink">{data.displayName}</p>
          <p className="truncate text-[12px] text-ink-2">{[data.jobTitle, data.userId].filter(Boolean).join(' · ')}</p>
        </div>
        <Badge tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{sapLabel(t, data.status)}</Badge>
      </header>
      <div className="px-4 py-3">
        <Fields>
          {data.department && <Field label={t('field.department')}>{data.department}</Field>}
          {data.division && <Field label={t('field.division')}>{data.division}</Field>}
          {data.location && <Field label={t('field.location')}>{data.location}</Field>}
          {data.managerName && <Field label={t('field.manager')}>{data.managerName}</Field>}
          {data.email && <Field label={t('field.email')}>{data.email}</Field>}
          {data.hireDate && <Field label={t('field.hireDate')}>{formatDate(data.hireDate)}</Field>}
          {since && <Field label={t('field.tenure')}>{since}</Field>}
        </Fields>
      </div>
      <Actions
        items={[
          { label: t('hr.reportingLine'), prompt: t('prompt.reportingLine', { id: data.userId }) },
          { label: t('hr.directReports'), prompt: t('prompt.team', { id: data.userId }) },
          { label: t('hr.jobHistory'), prompt: t('prompt.jobHistory', { id: data.userId }) },
        ]}
      />
    </section>
  );
}

/** The chain of managers, top of the organization first, ending with the employee. */
export function ReportingLineCard({ data }: { data: Of<'reporting_line'> }) {
  const t = useT();
  const ask = useAsk();
  const chain = [...data.managers].reverse();
  return (
    <section aria-label={t('hr.reportingLineOf', { name: data.employee.displayName })} className={FRAME}>
      <header className={HEADER}>
        <IconCircle>
          <ChevronUp size={18} />
        </IconCircle>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t('hr.reportingLine')}</p>
          <p className="truncate text-[14px] font-semibold text-ink">{data.employee.displayName}</p>
        </div>
      </header>
      <ol className="px-4 py-2">
        {[...chain, data.employee].map((p, i, all) => {
          const self = i === all.length - 1;
          return (
            <li key={p.userId} className="relative">
              {/* The connector to the next person down the line. */}
              {!self && <span aria-hidden className="absolute bottom-[-8px] start-4 top-10 w-px bg-line-strong" />}
              <div className={cx('rounded-lg', self && 'bg-brand-soft/60 px-2 -mx-2')}>
                <PersonLine
                  name={p.displayName}
                  detail={roleOf(p)}
                  aside={
                    self ? (
                      <Badge tone="brand">{chain.length ? t('hr.level', { level: chain.length + 1 }) : t('hr.top')}</Badge>
                    ) : (
                      <button type="button" onClick={() => ask(t('prompt.team', { id: p.userId }))} className="text-xs font-semibold text-brand hover:underline">
                        {t('hr.team')}
                      </button>
                    )
                  }
                />
              </div>
            </li>
          );
        })}
      </ol>
      {chain.length === 0 && <p className="px-4 pb-3 text-[12px] text-ink-2">{t('hr.noManager')}</p>}
    </section>
  );
}

const absenceTone: Record<Of<'time_off'>['upcoming'][number]['status'], Tone> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'critical', CANCELLED: 'neutral' };
const amount = (t: T, n: number, unit: 'DAYS' | 'HOURS') => t(unit === 'HOURS' ? 'hr.hours' : 'hr.days', { count: Number.isInteger(n) ? n : n.toFixed(1) });
const range = (from: string, to: string) => (from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`);

export function TimeOffCard({ data }: { data: Of<'time_off'> }) {
  const t = useT();
  const upcoming = useShowMore(data.upcoming, PREVIEW.absences);
  return (
    <section aria-label={t('hr.timeOffOf', { name: data.displayName })} className={FRAME}>
      <header className={HEADER}>
        <IconCircle>
          <CalendarDays size={18} />
        </IconCircle>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t('hr.timeOff')}</p>
          <p className="truncate text-[14px] font-semibold text-ink">{data.displayName}</p>
        </div>
      </header>
      <div className="px-4 py-3">
        {data.balances.length > 0 ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data.balances.map((b) => (
              <div key={b.account} className="rounded-lg border border-area-sap/20 bg-area-sap-fill px-3 py-2.5">
                <dt className="truncate text-xs text-ink-3">{b.account}</dt>
                <dd className="mt-0.5 text-base font-semibold text-ink">
                  {amount(t, b.balance, b.unit)} <span className="text-xs font-normal text-ink-3">{t('hr.left')}</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-ink-2">{t('hr.noAccount')}</p>
        )}
        <h4 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-ink-3">{t('hr.upcoming')}</h4>
        {data.upcoming.length > 0 ? (
          <ul className="divide-y divide-line">
            {upcoming.visible.map((a) => (
              <li key={`${a.startDate}-${a.timeType}`} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{range(a.startDate, a.endDate)}</p>
                  <p className="truncate text-[12px] text-ink-2">
                    {a.timeType}
                    {a.days !== undefined && ` · ${amount(t, a.days, 'DAYS')}`}
                  </p>
                </div>
                <Badge tone={absenceTone[a.status]}>{sapLabel(t, a.status)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-2">{t('hr.nothingPlanned')}</p>
        )}
        {upcoming.toggle}
      </div>
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) {
  return (
    <div className="rounded-lg border border-area-sap/20 bg-area-sap-fill px-3 py-2.5">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className={cx('mt-0.5 text-xl font-semibold', tone === 'warning' && value > 0 ? 'text-warning' : 'text-ink')}>{value}</dd>
    </div>
  );
}

const noteTone: Record<NonNullable<Of<'team_overview'>['members'][number]['noteTone']>, Tone> = { neutral: 'neutral', positive: 'success', warning: 'warning' };

export function TeamOverviewCard({ data }: { data: Of<'team_overview'> }) {
  const t = useT();
  const ask = useAsk();
  const members = useShowMore(data.members, PREVIEW.members);
  return (
    <section aria-label={t('hr.teamOf', { name: data.managerName })} className={FRAME}>
      <header className={HEADER}>
        <IconCircle>
          <Users size={18} />
        </IconCircle>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t('hr.team')}</p>
          <p className="truncate text-[14px] font-semibold text-ink">{data.managerName}</p>
        </div>
      </header>
      <div className="px-4 py-3">
        <dl className="grid grid-cols-3 gap-3">
          <Figure label={t('hr.headcount')} value={data.headcount} />
          {data.outToday !== undefined && <Figure label={t('hr.outToday')} value={data.outToday} tone="warning" />}
          {data.openRoles !== undefined && <Figure label={t('hr.openRoles')} value={data.openRoles} />}
        </dl>
        {data.members.length > 0 ? (
          <ul className="mt-3 divide-y divide-line">
            {members.visible.map((m) => (
              <li key={m.userId}>
                <button type="button" onClick={() => ask(t('prompt.employee', { id: m.userId }))} className="-mx-2 block w-[calc(100%+1rem)] rounded-lg px-2 text-start hover:bg-muted">
                  <PersonLine name={m.displayName} detail={roleOf(m)} aside={m.note && <Badge tone={noteTone[m.noteTone ?? 'neutral']}>{translateServer(m.note)}</Badge>} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-ink-2">{t('hr.nobodyReports', { name: data.managerName })}</p>
        )}
        {members.toggle}
        {data.openPositions && data.openPositions.length > 0 && (
          <>
            <h4 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-ink-3">{t('hr.openPositions')}</h4>
            <ul className="divide-y divide-line">
              {data.openPositions.map((p) => (
                <li key={p.code} className="flex items-center gap-3 py-2">
                  <IconCircle size="sm">
                    <BriefcaseBusiness size={14} />
                  </IconCircle>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{p.title ?? p.code}</p>
                    <p className="truncate text-[12px] text-ink-2">{[p.code, p.location].filter(Boolean).join(' · ')}</p>
                  </div>
                  <Badge tone="info">{t('hr.vacant')}</Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

export function ApprovalsCard({ data }: { data: Of<'approvals'> }) {
  const t = useT();
  const ask = useAsk();
  const items = useShowMore(data.items, PREVIEW.approvals);
  return (
    <section aria-label={t('hr.approvalsLabel')} className={FRAME}>
      <header className={HEADER}>
        <IconCircle>
          <ClipboardCheck size={18} />
        </IconCircle>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t('hr.approvals')}</p>
          <p className="truncate text-[14px] font-semibold text-ink">{t('hr.waiting')}</p>
        </div>
        <Badge tone="warning">{data.items.length}</Badge>
      </header>
      <ul className="divide-y divide-line px-4">
        {items.visible.map((r) => (
          <li key={r.id} className="py-3">
            <p className="text-sm font-medium text-ink">
              {r.subjectName ? `${r.subjectName} · ` : ''}
              {r.title}
            </p>
            <p className="text-[12px] text-ink-2">{[r.detail, r.requestedOn && t('hr.requested', { date: formatDate(r.requestedOn) })].filter(Boolean).join(' · ')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => ask(t('prompt.approve', { id: r.id }))} className={ACTION}>
                {t('hr.approve')}
              </button>
              <button type="button" onClick={() => ask(t('prompt.decline', { id: r.id }))} className={ACTION}>
                {t('hr.decline')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {items.toggle && <div className="px-4 pb-1">{items.toggle}</div>}
      <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-3">{t('hr.nothingDecided')}</p>
    </section>
  );
}
