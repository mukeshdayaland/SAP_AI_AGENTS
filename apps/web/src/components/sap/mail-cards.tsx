'use client';

import type { UIComponent } from '@prowess/contracts';
import { CalendarDays, ExternalLink, Inbox, Mail, MapPin, Paperclip, Users, Video } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { formatDate, formatDateTime } from '@/lib/format';
import { intlLocale, useT } from '@/lib/i18n';
import { Badge, cx, type Tone } from '../ui/primitives';
import { IconCircle, useAsk, useShowMore } from './card';

/**
 * Outlook mail and calendar cards. Mail comes from outside the company, so it is drawn as a non-SAP area,
 * shown as plain text only, and its links are limited to Outlook and Teams by the component contract.
 */

type Of<K extends UIComponent['type']> = Extract<UIComponent, { type: K }>['data'];

const PREVIEW = { mail: 6, events: 8, body: 1_200 } as const;

const FRAME = 'overflow-hidden rounded-area border border-area-nonsap/40 bg-surface shadow-soft';
const HEADER = 'flex items-center gap-3 border-b border-area-nonsap/20 bg-area-nonsap-fill px-4 py-3';
const LINK = 'inline-flex items-center gap-1 rounded-lg border border-brand/40 bg-surface px-2.5 py-1 text-xs font-semibold text-brand transition-colors hover:bg-brand-soft';

const sender = (a?: { name?: string; address: string }) => (a ? a.name || a.address : '');
const people = (list: { name?: string; address: string }[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

function Header({ icon, kind, title, badge }: { icon: ReactNode; kind: string; title: string; badge?: { label: string; tone: Tone } }) {
  return (
    <header className={HEADER}>
      <IconCircle>{icon}</IconCircle>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{kind}</p>
        <p className="truncate text-[14px] font-semibold text-ink">{title}</p>
      </div>
      {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
    </header>
  );
}

function OpenIn({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
      {label}
      <ExternalLink size={12} aria-hidden />
    </a>
  );
}

export function MailListCard({ data }: { data: Of<'mail_list'> }) {
  const t = useT();
  const ask = useAsk();
  const items = useShowMore(data.items, PREVIEW.mail);
  const unread = data.items.filter((m) => !m.isRead).length;
  return (
    <section aria-label={data.title} className={FRAME}>
      <Header icon={<Inbox size={18} />} kind={t('mail.kind')} title={data.title} {...(unread > 0 && { badge: { label: t('mail.unreadCount', { count: unread }), tone: 'info' as Tone } })} />
      <ul className="divide-y divide-line">
        {items.visible.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => ask(t('prompt.openMail', { subject: m.subject }))} className="flex w-full items-start gap-3 px-4 py-2.5 text-start transition-colors hover:bg-area-nonsap-fill">
              <span aria-hidden className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', m.isRead ? 'bg-transparent' : 'bg-brand')} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={cx('truncate text-sm', m.isRead ? 'text-ink-2' : 'font-semibold text-ink')}>{sender(m.from) || t('mail.unknownSender')}</span>
                  <span className="ms-auto shrink-0 text-[11px] text-ink-3">{formatDateTime(m.receivedAt)}</span>
                </span>
                <span className={cx('flex items-center gap-1.5 truncate text-[13px]', m.isRead ? 'text-ink-2' : 'font-medium text-ink')}>
                  {m.importance === 'high' && <span className="font-bold text-error" aria-label={t('mail.important')}>!</span>}
                  <span className="truncate">{m.subject}</span>
                  {m.hasAttachments && <Paperclip size={12} className="shrink-0 text-ink-3" aria-label={t('mail.hasAttachments')} />}
                </span>
                <span className="block truncate text-[12px] text-ink-3">{m.preview}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {items.toggle && <div className="px-4 pb-1">{items.toggle}</div>}
    </section>
  );
}

const STATUS: Record<Of<'mail_message'>['status'], { key: 'mail.received' | 'mail.draft' | 'mail.sent'; tone: Tone }> = {
  received: { key: 'mail.received', tone: 'neutral' },
  draft: { key: 'mail.draft', tone: 'warning' },
  sent: { key: 'mail.sent', tone: 'success' },
};

export function MailMessageCard({ data }: { data: Of<'mail_message'> }) {
  const t = useT();
  const [full, setFull] = useState(false);
  const long = data.body.length > PREVIEW.body;
  const body = full || !long ? data.body : `${data.body.slice(0, PREVIEW.body)}…`;
  return (
    <section aria-label={data.subject} className={FRAME}>
      <Header icon={<Mail size={18} />} kind={t('mail.message')} title={data.subject} badge={{ label: t(STATUS[data.status].key), tone: STATUS[data.status].tone }} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-[13px]">
        {data.from && (
          <>
            <dt className="text-ink-3">{t('mail.from')}</dt>
            <dd className="min-w-0 break-words text-ink">{people([data.from])}</dd>
          </>
        )}
        {data.to.length > 0 && (
          <>
            <dt className="text-ink-3">{t('mail.to')}</dt>
            <dd className="min-w-0 break-words text-ink">{people(data.to)}</dd>
          </>
        )}
        {data.cc.length > 0 && (
          <>
            <dt className="text-ink-3">{t('mail.cc')}</dt>
            <dd className="min-w-0 break-words text-ink">{people(data.cc)}</dd>
          </>
        )}
        {data.status === 'received' && (
          <>
            <dt className="text-ink-3">{t('mail.date')}</dt>
            <dd className="text-ink">{formatDateTime(data.receivedAt)}</dd>
          </>
        )}
      </dl>
      {/* Plain text, never HTML: what a sender writes cannot change the page. */}
      <div className="whitespace-pre-wrap break-words px-4 py-3 text-[13px] leading-relaxed text-ink">{body}</div>
      {long && (
        <div className="px-4 pb-2">
          <button type="button" onClick={() => setFull((f) => !f)} className="text-xs font-semibold text-brand hover:underline">
            {full ? t('mail.showLess') : t('mail.showAll')}
          </button>
        </div>
      )}
      {(data.attachments.length > 0 || data.webLink) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          {data.attachments.map((a) => (
            <span key={a.name} className="inline-flex items-center gap-1 rounded-md bg-area-nonsap-fill px-2 py-0.5 text-[12px] text-ink-2">
              <Paperclip size={12} aria-hidden />
              {a.name}
            </span>
          ))}
          {data.webLink && (
            <span className="ms-auto">
              <OpenIn href={data.webLink} label={t('mail.openInOutlook')} />
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** `2026-10-19T09:00` → the time in the user's locale; the value is already local to the calendar's time zone. */
const clock = (local: string) => {
  const [h, m] = local.slice(11, 16).split(':').map(Number);
  return new Date(Date.UTC(2000, 0, 1, h ?? 0, m ?? 0)).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
};

const showAsTone: Record<Of<'calendar'>['events'][number]['showAs'], Tone> = { free: 'success', tentative: 'warning', busy: 'info', oof: 'critical', workingElsewhere: 'neutral', unknown: 'neutral' };

export function CalendarCard({ data }: { data: Of<'calendar'> }) {
  const t = useT();
  const events = useShowMore(data.events, PREVIEW.events);
  const range = data.from === data.to ? formatDate(data.from) : `${formatDate(data.from)} – ${formatDate(data.to)}`;
  let lastDay = '';
  return (
    <section aria-label={t('calendar.label', { range })} className={FRAME}>
      <Header icon={<CalendarDays size={18} />} kind={t('calendar.kind')} title={range} badge={{ label: t('calendar.count', { count: data.events.length }), tone: 'neutral' }} />
      {data.events.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-2">{t('calendar.empty')}</p>
      ) : (
        <ul className="px-4">
          {events.visible.map((e) => {
            const day = e.start.slice(0, 10);
            const newDay = data.from !== data.to && day !== lastDay;
            lastDay = day;
            return (
              <li key={e.id}>
                {newDay && <h4 className="mt-3 text-xs font-semibold uppercase tracking-wider text-ink-3">{formatDate(day)}</h4>}
                <div className="flex gap-3 border-b border-line py-2.5 last:border-b-0">
                  <div className="w-20 shrink-0 text-[12px] tabular-nums text-ink-2">
                    {e.isAllDay ? (
                      t('calendar.allDay')
                    ) : (
                      <>
                        <div className="font-semibold text-ink">{clock(e.start)}</div>
                        <div>{clock(e.end)}</div>
                      </>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{e.subject}</p>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-2">
                      {e.location && (
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <MapPin size={12} aria-hidden />
                          <span className="truncate">{e.location}</span>
                        </span>
                      )}
                      {e.attendees > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Users size={12} aria-hidden />
                          {t('calendar.attendees', { count: e.attendees })}
                        </span>
                      )}
                      {e.organizer && <span className="truncate">{t('calendar.organizer', { name: sender(e.organizer) })}</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {e.showAs !== 'busy' && <Badge tone={showAsTone[e.showAs]}>{t(`calendar.showAs.${e.showAs}`)}</Badge>}
                    {e.joinUrl && (
                      <a href={e.joinUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
                        <Video size={12} aria-hidden />
                        {t('calendar.join')}
                      </a>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {events.toggle && <div className="px-4 pb-1">{events.toggle}</div>}
      <p className="border-t border-line px-4 py-2 text-[11px] text-ink-3">{t('calendar.timeZone', { zone: data.timeZone })}</p>
    </section>
  );
}
