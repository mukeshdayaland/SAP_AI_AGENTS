import type { ConversationSummary, Money } from '@prowess/contracts';

export function formatMoney(m: Money): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency, currencyDisplay: 'code', maximumFractionDigits: 2 }).format(m.amount);
  } catch {
    return `${m.currency} ${m.amount.toLocaleString()}`;
  }
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const humanize = (s: string) => s.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export type ConversationGroup = { label: string; items: ConversationSummary[] };

/** Groups conversations into Today / Yesterday / Previous 7 Days / Older. */
export function groupConversations(items: ConversationSummary[], now = new Date()): ConversationGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const buckets: ConversationGroup[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 Days', items: [] },
    { label: 'Older', items: [] },
  ];
  for (const c of items) {
    const t = new Date(c.updatedAt).getTime();
    const bucket = t >= startOfToday ? 0 : t >= startOfToday - day ? 1 : t >= startOfToday - 7 * day ? 2 : 3;
    buckets[bucket]!.items.push(c);
  }
  return buckets.filter((b) => b.items.length);
}

/** Only http(s) and mailto links are rendered as links. */
export function safeHref(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, 'https://invalid.local');
    if (url.origin === 'https://invalid.local') return undefined;
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
