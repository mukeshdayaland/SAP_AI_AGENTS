'use client';

import type { WorkspaceConfig } from '@prowess/contracts';
import { ChevronDown, Menu as MenuIcon } from 'lucide-react';
import { EnvironmentBadge, IconButton } from '../ui/primitives';

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

function Select({ id, label, value, options, onChange, disabled }: { id: string; label: string; value: string; options: { id: string; label: string; hint?: string }[]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 appearance-none rounded-lg border border-line bg-surface py-0 pl-2.5 pr-7 text-[13px] font-medium text-ink hover:border-line-strong disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id} title={o.hint}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-3" />
    </div>
  );
}

export function Header({ config, agent, tier, title, locked, onAgent, onTier, onOpenSidebar }: Props) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/80 px-3 backdrop-blur md:px-5">
      <span className="md:hidden">
        <IconButton label="Open conversations" onClick={onOpenSidebar}>
          <MenuIcon size={18} />
        </IconButton>
      </span>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">{title ?? <span className="sr-only">Prowess AI</span>}</h1>

      <div className="flex items-center gap-2">
        <Select
          id="agent-select"
          label="Agent"
          value={agent}
          disabled={locked}
          onChange={onAgent}
          options={config.agents.map((a) => ({ id: a.id, label: a.name, hint: a.description }))}
        />
        {config.modelTiers.length > 1 && (
          <span className="hidden sm:inline">
            <Select
              id="tier-select"
              label="Model"
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
