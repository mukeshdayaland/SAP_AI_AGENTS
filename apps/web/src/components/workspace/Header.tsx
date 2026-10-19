'use client';

import type { WorkspaceConfig } from '@prowess/contracts';
import { Check, ChevronDown, Menu as MenuIcon } from 'lucide-react';
import { EnvironmentBadge, IconButton, Menu, cx } from '../ui/primitives';
import { brand } from '@/lib/brand';
import { useT } from '@/lib/i18n';

interface Props {
  config: WorkspaceConfig;
  agent: string;
  tier: string;
  title: string | null;
  locked: boolean;
  onAgent: (id: string) => void;
  onTier: (id: string) => void;
  onOpenSidebar: () => void;
}

interface Choice {
  id: string;
  label: string;
  hint?: string;
}

/** Chooses one of a few named options. A native select cannot be styled on the brand bar; what an option is for shows as its tooltip. */
function Picker({ label, value, options, onChange, disabled }: { label: string; value: string; options: Choice[]; onChange: (v: string) => void; disabled?: boolean }) {
  const t = useT();
  const current = options.find((o) => o.id === value);
  return (
    <Menu
      label={t('header.choice', { label, value: current?.label ?? value })}
      disabled={disabled}
      compact
      triggerClassName="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface ps-2.5 pe-2 text-[12px] font-medium text-ink hover:border-line-strong disabled:opacity-60 aria-expanded:border-line-strong"
      trigger={
        <>
          {current?.label ?? value}
          <ChevronDown size={14} aria-hidden className="text-ink-3" />
        </>
      }
    >
      {(close) => (
        <div>
          {options.map((o) => {
            const selected = o.id === value;
            return (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={o.hint}
                onClick={() => {
                  close();
                  if (!selected) onChange(o.id);
                }}
                className={cx('flex w-full items-center gap-6 rounded-lg px-2.5 py-1.5 text-start hover:bg-muted focus:bg-muted focus:outline-none', selected && 'bg-muted')}
              >
                <span className="flex-1 whitespace-nowrap text-sm font-medium text-ink">{o.label}</span>
                <Check size={15} aria-hidden className={cx('shrink-0 text-brand', !selected && 'invisible')} />
              </button>
            );
          })}
        </div>
      )}
    </Menu>
  );
}
export function Header({ config, agent, tier, title, locked, onAgent, onTier, onOpenSidebar }: Props) {
  const t = useT();
  return (
    // Above the conversation, so an open picker is never painted over by a card.
    <header className="brand-bar relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/80 px-3 backdrop-blur md:px-5">
      <span className="md:hidden">
        <IconButton label={t('header.openConversations')} onClick={onOpenSidebar}>
          <MenuIcon size={18} />
        </IconButton>
      </span>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">{title ? <bdi>{title}</bdi> : <span className="sr-only">{brand.name}</span>}</h1>

      <div className="flex items-center gap-2">
        <Picker
          label={t('header.agent')}
          value={agent}
          disabled={locked}
          onChange={onAgent}
          options={config.agents.map((a) => ({ id: a.id, label: a.name, hint: a.description }))}
        />
        {config.modelTiers.length > 1 && (
          <span className="hidden sm:inline">
            <Picker
              label={t('header.model')}
              value={tier}
              disabled={locked}
              onChange={onTier}
              options={config.modelTiers.map((t) => ({ id: t.id, label: t.label, hint: t.description }))}
            />
          </span>
        )}
        <span className="hidden lg:inline-flex">
          <EnvironmentBadge env={config.environment} />
        </span>
      </div>
    </header>
  );
}
