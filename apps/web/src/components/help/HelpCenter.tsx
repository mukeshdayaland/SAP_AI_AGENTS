'use client';

import type { ActivityEntry, HelpCapability, HelpOverview, PublicError, WorkspaceConfig } from '@prowess/contracts';
import { ArrowLeft, Coins, Package, Sparkles, Truck, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiError } from '@/lib/api';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge, EnvironmentBadge, ProwessMark, Spinner, cx, type Tone } from '../ui/primitives';

const TABS = ['Agents', 'Tools', 'My activity'] as const;
type Tab = (typeof TABS)[number];

const ICONS: Record<string, LucideIcon> = { coins: Coins, package: Package, truck: Truck };

const KIND: Record<HelpCapability['risk'], { label: string; tone: Tone }> = {
  READ: { label: 'Reads data', tone: 'success' },
  LOW_RISK_WRITE: { label: 'Change · you confirm', tone: 'info' },
  BUSINESS_WRITE: { label: 'Change · you confirm', tone: 'warning' },
  HIGH_IMPACT: { label: 'Posting · you confirm', tone: 'critical' },
};

const EVENT: Record<string, string> = {
  SAP_READ: 'Read',
  SAP_WRITE_REQUESTED: 'Change proposed',
  SAP_WRITE_CONFIRMED: 'Change confirmed',
  SAP_WRITE_CANCELLED: 'Change cancelled',
  SAP_WRITE_COMPLETED: 'Change posted',
  SAP_WRITE_FAILED: 'Change failed',
  WORKFLOW_STARTED: 'Process started',
  WORKFLOW_ENDED: 'Process ended',
};

const STATUS: Record<ActivityEntry['status'], { label: string; tone: Tone }> = {
  success: { label: 'Done', tone: 'success' },
  pending: { label: 'Waiting', tone: 'warning' },
  denied: { label: 'Denied', tone: 'critical' },
  failure: { label: 'Failed', tone: 'critical' },
};

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto rounded-area border border-line bg-surface">
      <table className="w-full text-left text-[13px]">
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
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [help, setHelp] = useState<HelpOverview | null>(null);
  const [error, setError] = useState<PublicError | null>(null);
  const [tab, setTab] = useState<Tab>('Agents');

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
        const row = byTitle.get(c.title) ?? { ...c, agents: [] };
        row.agents.push(a.name);
        byTitle.set(c.title, row);
      }
    }
    return [...byTitle.values()].sort((x, y) => Number(x.needsConfirmation) - Number(y.needsConfirmation) || x.title.localeCompare(y.title));
  }, [help]);

  if (error) return <p className="p-8 text-ink">{error.message}</p>;
  if (!config || !help) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-brand" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <a href="/" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-muted hover:text-ink">
            <ArrowLeft size={15} aria-hidden /> Workspace
          </a>
          <ProwessMark size={24} />
          <h1 className="text-[15px] font-semibold text-ink">Help</h1>
          <span className="ml-auto">
            <EnvironmentBadge env={config.environment} />
          </span>
        </div>
        <nav aria-label="Help sections" className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === t ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink')}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6" role="tabpanel" aria-label={tab}>
        {tab === 'Agents' && (
          <>
            <p className="text-sm text-ink-2">Choose an agent in the workspace header. Each one works in its own SAP area and uses your SAP authorizations.</p>
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
                    <p className="mt-3 text-[13px] text-ink-2">{a.description}</p>
                    <p className="mt-3 text-xs text-ink-3">
                      {a.capabilities.length - changes.length} ways to read data · {changes.length} {changes.length === 1 ? 'change' : 'changes'} you confirm
                    </p>
                    {changes.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {changes.map((c) => (
                          <li key={c.title}>
                            <Badge tone={KIND[c.risk].tone}>{c.title}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                    {examples.length > 0 && (
                      <div className="mt-4 border-t border-line pt-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Try asking</h3>
                        <ul className="mt-1.5 space-y-1.5 text-[13px] text-ink">
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

        {tab === 'Tools' && (
          <>
            <p className="text-sm text-ink-2">Everything the agents can do in SAP for you. Nothing is changed in SAP until you confirm it, and SAP checks your authorization every time.</p>
            <Table
              head={['Action', 'Agent', 'Type']}
              empty="No tools are available right now."
              rows={tools.map((t) => [
                <div key="a">
                  <strong className="font-semibold">{t.title}</strong>
                  <p className="mt-0.5 text-xs text-ink-3">{t.description}</p>
                </div>,
                <span key="g" className="whitespace-nowrap">
                  {t.agents.join(', ')}
                </span>,
                <Badge key="k" tone={KIND[t.risk].tone} className="whitespace-nowrap">
                  {KIND[t.risk].label}
                </Badge>,
              ])}
            />
          </>
        )}

        {tab === 'My activity' && (
          <>
            <p className="text-sm text-ink-2">Your most recent SAP reads, changes and process runs through Prowess AI. Only you see this list; it covers recent activity and is not the permanent audit record.</p>
            <Table
              head={['Time', 'Event', 'Action', 'Object', 'Agent', 'System', 'Status']}
              empty="You have no SAP activity yet."
              rows={help.activity.map((e) => [
                <span key="t" className="whitespace-nowrap">
                  {formatDateTime(e.timestamp)}
                </span>,
                EVENT[e.type] ?? e.type,
                e.action ?? '—',
                e.object ?? '—',
                e.agent ?? '—',
                e.system ?? '—',
                <Badge key="s" tone={STATUS[e.status].tone}>
                  {STATUS[e.status].label}
                </Badge>,
              ])}
            />
          </>
        )}
      </main>
    </div>
  );
}
