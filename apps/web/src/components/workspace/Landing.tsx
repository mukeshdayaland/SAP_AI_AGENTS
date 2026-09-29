'use client';

import type { StarterAction, WorkspaceConfig } from '@prowess/contracts';
import { Building2, FileText, Package, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import { ProwessMark } from '../ui/primitives';
import { SolutionPath } from './SolutionPath';

const ICONS: Record<string, LucideIcon> = { receipt: FileText, package: Package, building: Building2, wrench: Wrench };

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Empty state. Starter actions come from server configuration, not code. */
export function Landing({ config, onStarter }: { config: WorkspaceConfig; onStarter: (s: StarterAction) => void }) {
  const first = config.user.displayName.split(' ')[0];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-10 text-center">
      <ProwessMark size={52} />
      <p className="mt-5 text-[13px] font-semibold uppercase tracking-[0.18em] text-brand">{config.product.name}</p>
      <p className="mt-1 text-sm text-ink-3">{config.product.subtitle}</p>
      <h2 className="mt-6 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
        {greeting()}, {first}. How can I help you today?
      </h2>
      <SolutionPath />
      {config.starters.length > 0 && (
        <ul className="mt-8 grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-2">
          {config.starters.map((s) => {
            const Icon = ICONS[s.icon] ?? Sparkles;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onStarter(s)}
                  className="group flex h-full w-full items-start gap-3 rounded-area border border-line bg-surface p-4 text-left shadow-soft transition-all hover:-translate-y-px hover:border-area-sap hover:bg-area-sap-fill hover:shadow-lift"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-area-nonsap-fill text-brand">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-ink">{s.label}</span>
                    <span className="mt-0.5 block text-[13px] text-ink-3 group-hover:text-ink-2">{s.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
