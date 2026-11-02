'use client';

import type { ActivityEntry, HelpCapability, HelpOverview, PublicError, WorkspaceConfig } from '@prowess/contracts';
import { ArrowLeft, Coins, Mail, Package, Sparkles, Truck, Users, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiError } from '@/lib/api';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { isMessageKey, translateServer, useDocumentTitle, useT, type T } from '@/lib/i18n';
import { Badge, EnvironmentBadge, ProwessMark, Spinner, cx, type Tone } from '../ui/primitives';
import { brand } from '@/lib/brand';

const TABS = ['agents', 'tools', 'activity'] as const;
type Tab = (typeof TABS)[number];

const ICONS: Record<string, LucideIcon> = { coins: Coins, package: Package, truck: Truck, users: Users, mail: Mail };

const KIND: Record<HelpCapability['risk'], Tone> = { READ: 'success', LOW_RISK_WRITE: 'info', BUSINESS_WRITE: 'warning', HIGH_IMPACT: 'critical' };

const STATUS: Record<ActivityEntry['status'], Tone> = { success: 'success', pending: 'warning', denied: 'critical', failure: 'critical' };

/** An audit event type in the user's language; an unknown type is shown as recorded. */
const eventLabel = (t: T, type: string) => {
  const key = `help.event.${type}`;
  return isMessageKey(key) ? t(key) : type;
};

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto rounded-area border border-line bg-surface">
      <table className="w-full text-start text-[12px]">
        <thead className="bg-muted text-ink-2">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line align-top">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 text-ink">
                  {c}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={head.length} className="px-3 py-6 text-center text-ink-3">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** What the user's agents can do, and what the user has done in SAP through them. */
export function HelpCenter() {
  const t = useT();
  useDocumentTitle('help.title');
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [help, setHelp] = useState<HelpOverview | null>(null);
  const [error, setError] = useState<PublicError | null>(null);
  const [tab, setTab] = useState<Tab>('agents');

  useEffect(() => {
    Promise.all([api.workspace(), api.help()])
      .then(([c, h]) => {
        setConfig(c);
        setHelp(h);
      })
      .catch((e: ApiError) => setError(e.error));
  }, []);

  // One row per tool, with every agent that offers it.
  const tools = useMemo(() => {
    const byTitle = new Map<string, HelpCapability & { agents: string[] }>();
    for (const a of help?.agents ?? []) {
      for (const c of a.capabilities) {
        const row = byTitle.get(c.title) ?? { ...c, title: translateServer(c.title), agents: [] };
        row.agents.push(a.name);
        byTitle.set(c.title, row);
      }
    }
    return [...byTitle.values()].sort((x, y) => Number(x.needsConfirmation) - Number(y.needsConfirmation) || x.title.localeCompare(y.title));
  }, [help]);

  if (error) return <p className="p-8 text-ink">{translateServer(error.message)}</p>;
  if (!config || !help) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-brand" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="brand-bar sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <a href="/" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-muted hover:text-ink">
            <ArrowLeft size={15} aria-hidden className="rtl:-scale-x-100" /> {t('common.workspace')}
          </a>
          <ProwessMark size={24} />
          <h1 className="text-[14px] font-semibold text-ink">{t('help.title')}</h1>
          <span className="ms-auto">
            <EnvironmentBadge env={config.environment} />
          </span>
        </div>
        <nav aria-label={t('help.sections')} className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4" role="tablist">
          {TABS.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === id ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink')}
            >
              {t(`help.tab.${id}`)}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6" role="tabpanel" aria-label={t(`help.tab.${tab}`)}>
        {tab === 'agents' && (
          <>
            <p className="text-sm text-ink-2">{t('help.agentsIntro')}</p>
            <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {help.agents.map((a) => {
                const Icon = ICONS[a.icon] ?? Sparkles;
                const changes = a.capabilities.filter((c) => c.needsConfirmation);
                const examples = config.starters.filter((s) => s.agent === a.id);
                return (
                  <li key={a.id} className="flex flex-col rounded-area border border-line bg-surface p-4 shadow-soft">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-area-nonsap-fill text-brand">
                        <Icon size={18} aria-hidden />
                      </span>
                      <h2 className="text-base font-semibold text-ink">{a.name}</h2>
                    </div>
                    <p className="mt-3 text-[12px] text-ink-2">{a.description}</p>
                    <p className="mt-3 text-xs text-ink-3">
                      {t('help.reads', { count: a.capabilities.length - changes.length })} · {t('help.changes', { count: changes.length })}
                    </p>
                    {changes.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {changes.map((c) => (
                          <li key={c.title}>
                            <Badge tone={KIND[c.risk]}>{translateServer(c.title)}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                    {examples.length > 0 && (
                      <div className="mt-4 border-t border-line pt-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">{t('help.tryAsking')}</h3>
                        <ul className="mt-1.5 space-y-1.5 text-[12px] text-ink">
                          {examples.map((s) => (
                            <li key={s.id}>“{s.prompt}”</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {tab === 'tools' && (
          <>
            <p className="text-sm text-ink-2">{t('help.toolsIntro')}</p>
            <Table
              head={[t('help.col.action'), t('help.col.agent'), t('help.col.type')]}
              empty={t('help.noTools')}
              rows={tools.map((tool) => [
                <div key="a">
                  <strong className="font-semibold">{tool.title}</strong>
                  <p className="mt-0.5 text-xs text-ink-3">{translateServer(tool.description)}</p>
                </div>,
                <span key="g" className="whitespace-nowrap">
                  {tool.agents.join(', ')}
                </span>,
                <Badge key="k" tone={KIND[tool.risk]} className="whitespace-nowrap">
                  {t(`help.kind.${tool.risk}`)}
                </Badge>,
              ])}
            />
          </>
        )}

        {tab === 'activity' && (
          <>
            <p className="text-sm text-ink-2">{t('help.activityIntro', { name: brand.name })}</p>
            <Table
              head={[t('help.col.time'), t('help.col.event'), t('help.col.action'), t('help.col.object'), t('help.col.agent'), t('help.col.system'), t('help.col.status')]}
              empty={t('help.noActivity')}
              rows={help.activity.map((e) => [
                <span key="t" className="whitespace-nowrap">
                  {formatDateTime(e.timestamp)}
                </span>,
                eventLabel(t, e.type),
                e.action ? translateServer(e.action) : '—',
                e.object ?? '—',
                e.agent ?? '—',
                e.system ?? '—',
                <Badge key="s" tone={STATUS[e.status]}>
                  {t(`help.status.${e.status}`)}
                </Badge>,
              ])}
            />
          </>
        )}
      </main>
    </div>
  );
}
