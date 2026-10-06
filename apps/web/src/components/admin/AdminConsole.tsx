'use client';

import type { PublicError, WorkspaceConfig } from '@prowess/contracts';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ApiError} from '@/lib/api';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge, EnvironmentBadge, ProwessMark, Spinner, cx, type Tone } from '../ui/primitives';

/* Shapes returned by /api/v1/admin/overview (read-only; secrets are never included). */
interface Overview {
  environment: WorkspaceConfig['environment'];
  providers: { id: string; healthy: boolean; note: string }[];
  preferredProvider: string | null;
  modelTiers: { id: string; label: string; fallback: boolean; privateOnly?: boolean; requiredRoles: string[]; maxOutputTokens: number; resolved: { provider: string; model: string }[] }[];
  agents: { id: string; name: string; description: string; allowedTools: string[]; modelTiers: string[]; requiredRoles: string[]; enabled: boolean }[];
  tools: { name: string; title: string; risk: string; domain: string; server: string; system: string }[];
  mcpServers: { id: string; healthy: boolean }[];
  usage: { day: string; provider: string; modelTier: string; agent: string; inputTokens: number; outputTokens: number; requests: number }[];
  settings: Record<string, unknown>;
}

const TABS = ['Overview', 'Models', 'Agents', 'Tools', 'Usage', 'Audit'] as const;
type Tab = (typeof TABS)[number];

const riskTone = (r: string): Tone => (r === 'HIGH_IMPACT' ? 'critical' : r === 'BUSINESS_WRITE' ? 'warning' : r === 'LOW_RISK_WRITE' ? 'info' : 'success');

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-area border border-line bg-surface">
      <table className="w-full text-left text-[12px]">
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
                No data yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const Health = ({ ok }: { ok: boolean }) => <Badge tone={ok ? 'success' : 'critical'}>{ok ? 'Healthy' : 'Unavailable'}</Badge>;

export function AdminConsole() {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [audit, setAudit] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<PublicError | null>(null);
  const [tab, setTab] = useState<Tab>('Overview');

  useEffect(() => {
    api.workspace().then(async (c) => {
      setConfig(c);
      setTab(c.features.admin ? 'Overview' : 'Audit');
      if (c.features.admin) setOverview((await api.adminOverview()) as unknown as Overview);
      if (c.features.audit) setAudit((await api.audit()).events);
    }).catch((e: ApiError) => setError(e.error));
  }, []);

  if (error) return <p className="p-8 text-ink">{error.message}</p>;
  if (!config) return <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6 text-brand" /></div>;
  if (!config.features.admin && !config.features.audit) return <p className="p-8 text-ink">You do not have access to administration.</p>;

  const tabs = TABS.filter((t) => (t === 'Audit' ? config.features.audit : config.features.admin));

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <a href="/" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-muted hover:text-ink">
            <ArrowLeft size={15} aria-hidden /> Workspace
          </a>
          <ProwessMark size={24} />
          <h1 className="text-[14px] font-semibold text-ink">Administration</h1>
          <span className="ml-auto">
            <EnvironmentBadge env={config.environment} />
          </span>
        </div>
        <nav aria-label="Administration sections" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4" role="tablist">
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx('border-b-2 px-3 py-2 text-sm font-medium', tab === t ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink')}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6" role="tabpanel" aria-label={tab}>
        <p className="rounded-lg border border-line bg-muted px-3 py-2 text-[12px] text-ink-2">
          Configuration is read-only here and managed through version-controlled files and BTP bindings. Provider credentials are never displayed.
        </p>

        {tab === 'Overview' && overview && (
          <>
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink">Model providers</h2>
              <Table
                head={['Provider', 'Status', 'Configuration', 'Default']}
                rows={overview.providers.map((p) => [<span key="p" className="font-mono">{p.id}</span>, <Health key="h" ok={p.healthy} />, p.note, overview.preferredProvider === p.id ? 'Preferred' : ''])}
              />
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink">MCP servers</h2>
              <Table head={['Server', 'Status']} rows={overview.mcpServers.map((m) => [m.id, <Health key="h" ok={m.healthy} />])} />
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink">Platform settings</h2>
              <pre className="overflow-x-auto rounded-area border border-line bg-surface p-4 font-mono text-xs text-ink-2">{JSON.stringify(overview.settings, null, 2)}</pre>
            </section>
          </>
        )}

        {tab === 'Models' && overview && (
          <Table
            head={['Tier', 'Access', 'Policy', 'Resolved targets (in order)']}
            rows={overview.modelTiers.map((t) => [
              <strong key="l">{t.label}</strong>,
              t.requiredRoles.join(', '),
              `${t.privateOnly ? 'Private only · ' : ''}${t.fallback ? 'Fallback allowed' : 'No fallback'} · max ${t.maxOutputTokens} tokens`,
              <ol key="r" className="list-decimal pl-4 font-mono text-xs">
                {t.resolved.map((r) => (
                  <li key={`${r.provider}${r.model}`}>
                    {r.provider} · {r.model}
                  </li>
                ))}
              </ol>,
            ])}
          />
        )}

        {tab === 'Agents' && overview && (
          <Table
            head={['Agent', 'Roles', 'Tiers', 'Allowed tools']}
            rows={overview.agents.map((a) => [
              <div key="a">
                <strong>{a.name}</strong>
                <p className="text-xs text-ink-3">{a.description}</p>
              </div>,
              a.requiredRoles.join(', '),
              a.modelTiers.join(', '),
              <span key="t" className="font-mono text-xs">{a.allowedTools.join(' ')}</span>,
            ])}
          />
        )}

        {tab === 'Tools' && overview && (
          <Table
            head={['Tool', 'Domain', 'Risk', 'Server / system']}
            rows={overview.tools.map((t) => [
              <div key="n">
                <span className="font-mono">{t.name}</span>
                <p className="text-xs text-ink-3">{t.title}</p>
              </div>,
              t.domain.toUpperCase(),
              <Badge key="r" tone={riskTone(t.risk)}>{t.risk.replaceAll('_', ' ').toLowerCase()}</Badge>,
              `${t.server} / ${t.system}`,
            ])}
          />
        )}

        {tab === 'Usage' && overview && (
          <Table
            head={['Day', 'Provider', 'Tier', 'Agent', 'Requests', 'Input tokens', 'Output tokens']}
            rows={overview.usage.map((u) => [u.day, u.provider, u.modelTier, u.agent, u.requests, u.inputTokens.toLocaleString(), u.outputTokens.toLocaleString()])}
          />
        )}

        {tab === 'Audit' && (
          <>
            <p className="text-[12px] text-ink-3">Most recent events on this instance. The authoritative trail is the SAP Audit Log service.</p>
            <Table
              head={['Time', 'Event', 'User', 'Agent / tool', 'System', 'Status', 'Correlation']}
              rows={(audit ?? []).map((e) => [
                formatDateTime(String(e.timestamp)),
                <span key="t" className="font-mono text-xs">{String(e.type)}</span>,
                String(e.userId),
                [e.agent, e.tool].filter(Boolean).join(' / '),
                String(e.targetSystem ?? ''),
                <Badge key="s" tone={e.status === 'success' ? 'success' : e.status === 'pending' ? 'warning' : 'critical'}>{String(e.status)}</Badge>,
                <span key="c" className="font-mono text-[10px]">{String(e.correlationId)}</span>,
              ])}
            />
          </>
        )}
      </main>
    </div>
  );
}
