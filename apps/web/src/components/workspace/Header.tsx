'use client';

import type { WorkspaceConfig } from '@prowess/contracts';
import { ChevronDown, LayoutDashboard, LogOut, Menu as MenuIcon, Monitor, Moon, Settings, Sun } from 'lucide-react';
import type { ThemePref } from '@/lib/prefs';
import { EnvironmentBadge, IconButton, Menu, MenuItem } from '../ui/primitives';

interface Props {
  config: WorkspaceConfig;
  agent: string;
  tier: string;
  title: string | null;
  theme: ThemePref;
  locked: boolean;
  onAgent: (id: string) => void;
  onTier: (id: string) => void;
  onTheme: (t: ThemePref) => void;
  onOpenSidebar: () => void;
  onSettings: () => void;
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

export function Header({ config, agent, tier, title, theme, locked, onAgent, onTier, onTheme, onOpenSidebar, onSettings }: Props) {
  const nextTheme: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
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
        <IconButton label={`Theme: ${theme} (switch to ${nextTheme[theme]})`} onClick={() => onTheme(nextTheme[theme])}>
          <ThemeIcon size={16} />
        </IconButton>
        <Menu
          label="User menu"
          trigger={
            <>
              <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                {config.user.displayName
                  .split(' ')
                  .map((s) => s[0])
                  .join('')
                  .slice(0, 2)}
              </span>
              <ChevronDown size={14} className="hidden text-ink-3 sm:block" />
            </>
          }
        >
          {() => (
            <>
              <div className="border-b border-line px-2.5 pb-2 pt-1.5">
                <p className="text-sm font-medium text-ink">{config.user.displayName}</p>
                <p className="text-xs text-ink-3">{config.user.email ?? config.user.id}</p>
                <p className="mt-1.5 flex flex-wrap gap-1">
                  {config.user.roles.map((r) => (
                    <span key={r} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
                      {r}
                    </span>
                  ))}
                </p>
                <p className="mt-1.5 text-[11px] leading-snug text-ink-3">Prowess roles control AI features only. SAP checks your SAP authorizations on every request.</p>
              </div>
              <div className="pt-1">
                <MenuItem onSelect={onSettings}>
                  <Settings size={15} /> Settings
                </MenuItem>
                {(config.features.admin || config.features.audit) && (
                  <MenuItem href="/admin/">
                    <LayoutDashboard size={15} /> Administration
                  </MenuItem>
                )}
                <MenuItem href="/logout">
                  <LogOut size={15} /> Sign out
                </MenuItem>
              </div>
            </>
          )}
        </Menu>
      </div>
    </header>
  );
}
