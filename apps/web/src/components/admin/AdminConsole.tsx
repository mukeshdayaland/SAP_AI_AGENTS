'use client';

import type { PublicError, WorkspaceConfig } from '@prowess/contracts';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ApiError} from '@/lib/api';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { intlLocale, isMessageKey, translateServer, useDocumentTitle, useT, type MessageKey } from '@/lib/i18n';
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

const TABS = ['overview', 'models', 'agents', 'tools', 'usage', 'audit'] as const;
type Tab = (typeof TABS)[number];

const riskTone = (r: string): Tone => (r === 'HIGH_IMPACT' ? 'critical' : r === 'BUSINESS_WRITE' ? 'warning' : r === 'LOW_RISK_WRITE' ? 'info' : 'success');

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  const t = useT();
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
                {t('common.noData')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Health({ ok }: { ok: boolean }) {
  const t = useT();
  return <Badge tone={ok ? 'success' : 'critical'}>{t(ok ? 'admin.healthy' : 'admin.unavailable')}</Badge>;
}

export function AdminConsole() {
  const t = useT();
  useDocumentTitle('admin.title');
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [audit, setAudit] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<PublicError | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    api.workspace().then(async (c) => {
      setConfig(c);
      setTab(c.features.admin ? 'overview' : 'audit');
      if (c.features.admin) setOverview((await api.adminOverview()) as unknown as Overview);
      if (c.features.audit) setAudit((await api.audit()).events);
    }).catch((e: ApiError) => setError(e.error));
  }, []);

  if (error) return <p className="p-8 text-ink">{translateServer(error.message)}</p>;
  if (!config) return <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6 text-brand" /></div>;
  if (!config.features.admin && !config.features.audit) return <p className="p-8 text-ink">{t('admin.noAccess')}</p>;

  const tabs = TABS.filter((id) => (id === 'audit' ? config.features.audit : config.features.admin));

  return (
    <div className="h-full overflow-y-auto">
      <header className="brand-bar sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <a href="/" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-muted hover:text-ink">
            <ArrowLeft size={15} aria-hidden className="rtl:-scale-x-100" /> {t('common.workspace')}
          </a>
          <ProwessMark size={24} />
          <h1 className="text-[14px] font-semibold text-ink">{t('admin.title')}</h1>
          <span className="ms-auto">
            <EnvironmentBadge env={config.environment} />
          </span>
        </div>
        <nav aria-label={t('admin.sections')} className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4" role="tablist">
          {tabs.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cx('border-b-2 px-3 py-2 text-sm font-medium', tab === id ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink')}
            >
              {t(`admin.tab.${id}`)}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6" role="tabpanel" aria-label={t(`admin.tab.${tab}`)}>
        <p className="rounded-lg border border-line bg-muted px-3 py-2 text-[12px] text-ink-2">
          {t('admin.readOnly')}
        </p>

        {tab === 'overview' && overview && (
          <>
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink">{t('admin.providers')}</h2>
              <Table
                head={[t('admin.col.provider'), t('admin.col.status'), t('admin.col.configuration'), t('admin.col.default')]}
                rows={overview.providers.map((p) => [<span key="p" className="font-mono">{p.id}</span>, <Health key="h" ok={p.healthy} />, p.note, overview.preferredProvider === p.id ? t('admin.preferred') : ''])}
              />
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink">{t('admin.mcp')}</h2>
              <Table head={[t('admin.col.server'), t('admin.col.status')]} rows={overview.mcpServers.map((m) => [m.id, <Health key="h" ok={m.healthy} />])} />
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink">{t('admin.settings')}</h2>
              <pre className="overflow-x-auto rounded-area border border-line bg-surface p-4 font-mono text-xs text-ink-2">{JSON.stringify(overview.settings, null, 2)}</pre>
            </section>
          </>
        )}

        {tab === 'models' && overview && (
          <Table
            head={[t('admin.col.tier'), t('admin.col.access'), t('admin.col.policy'), t('admin.col.targets')]}
            rows={overview.modelTiers.map((tier) => [
              <strong key="l">{tier.label}</strong>,
              tier.requiredRoles.join(', '),
              `${tier.privateOnly ? t('admin.privateOnly') : ''}${t(tier.fallback ? 'admin.fallback' : 'admin.noFallback')} · ${t('admin.maxTokens', { count: tier.maxOutputTokens })}`,
              <ol key="r" className="list-decimal ps-4 font-mono text-xs">
                {tier.resolved.map((r) => (
                  <li key={`${r.provider}${r.model}`}>
                    {r.provider} · {r.model}
                  </li>
                ))}
              </ol>,
            ])}
          />
        )}

        {tab === 'agents' && overview && (
          <Table
            head={[t('admin.col.agent'), t('admin.col.roles'), t('admin.col.tiers'), t('admin.col.allowedTools')]}
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

        {tab === 'tools' && overview && (
          <Table
            head={[t('admin.col.tool'), t('admin.col.domain'), t('admin.col.risk'), t('admin.col.serverSystem')]}
            rows={overview.tools.map((tool) => [
              <div key="n">
                <span className="font-mono">{tool.name}</span>
                <p className="text-xs text-ink-3">{translateServer(tool.title)}</p>
              </div>,
              tool.domain.toUpperCase(),
              <Badge key="r" tone={riskTone(tool.risk)}>
                {isMessageKey(`risk.${tool.risk}`) ? t(`risk.${tool.risk}` as MessageKey) : tool.risk}
              </Badge>,
              `${tool.server} / ${tool.system}`,
            ])}
          />
        )}

        {tab === 'usage' && overview && (
          <Table
            head={[t('admin.col.day'), t('admin.col.provider'), t('admin.col.tier'), t('admin.col.agent'), t('admin.col.requests'), t('admin.col.input'), t('admin.col.output')]}
            rows={overview.usage.map((u) => [u.day, u.provider, u.modelTier, u.agent, u.requests, u.inputTokens.toLocaleString(intlLocale()), u.outputTokens.toLocaleString(intlLocale())])}
          />
        )}

        {tab === 'audit' && (
          <>
            <p className="text-[12px] text-ink-3">{t('admin.auditIntro')}</p>
            <Table
              head={[t('admin.col.time'), t('admin.col.event'), t('admin.col.user'), t('admin.col.agentTool'), t('admin.col.system'), t('admin.col.status'), t('admin.col.correlation')]}
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
