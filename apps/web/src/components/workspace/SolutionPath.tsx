'use client';

import { Bot, Database, Server, User } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../ui/primitives';

/**
 * A miniature SAP BTP solution diagram of the request path, drawn with the
 * guideline's vocabulary: grey non-SAP area, blue SAP BTP area with unfilled
 * nested elements, numbered path markers and solid (synchronous) connectors.
 * Purely explanatory — it tells users where their question goes.
 */

function Node({ icon, label, sub }: { icon: ReactNode; label: string; sub: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left">
      <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-area-nonsap-fill text-brand">
        {icon}
      </span>
      <span className="leading-tight">
        <span className="block text-[12px] font-bold text-ink">{label}</span>
        <span className="block text-[10.5px] text-ink-3">{sub}</span>
      </span>
    </div>
  );
}

function Connector({ n, className }: { n: number; className?: string }) {
  return (
    <div aria-hidden className={cx('relative flex min-w-8 flex-1 items-center', className)}>
      <span className="w-full border-t-2 border-solid border-brand" />
      <span className="absolute left-1/2 top-1/2 flex h-4.5 w-4.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-on-brand">
        {n}
      </span>
      <span className="absolute right-0 top-1/2 h-0 w-0 -translate-y-1/2 border-y-[4px] border-l-[6px] border-y-transparent border-l-brand" />
    </div>
  );
}

function Area({ kind, label, children }: { kind: 'sap' | 'sap-outline' | 'nonsap'; label: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded-area border-[1.5px] px-2.5 pb-2.5 pt-1.5',
        kind === 'nonsap' && 'border-area-nonsap bg-area-nonsap-fill',
        kind === 'sap' && 'border-area-sap bg-area-sap-fill',
        kind === 'sap-outline' && 'border-area-sap bg-surface',
      )}
    >
      <p className={cx('mb-1.5 text-left text-[10.5px] font-bold', kind === 'nonsap' ? 'text-area-nonsap' : 'text-area-sap')}>{label}</p>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function SolutionPath() {
  return (
    <figure className="mt-8 hidden w-full sm:block" aria-label="How your request is handled">
      <div className="flex items-center">
        <Area kind="nonsap" label="Your workspace">
          <Node icon={<User size={13} />} label="You" sub="Corporate SSO" />
        </Area>
        <Connector n={1} />
        <Area kind="sap" label="SAP BTP">
          <Node icon={<Bot size={13} />} label="Prowess AI" sub="Agents · models" />
          <Connector n={2} className="min-w-6" />
          <Node icon={<Server size={13} />} label="SAP MCP" sub="Authorized tools" />
        </Area>
        <Connector n={3} />
        <Area kind="sap-outline" label="SAP S/4HANA">
          <Node icon={<Database size={13} />} label="Business data" sub="Your SAP authorizations" />
        </Area>
      </div>
      <figcaption className="mt-2 text-[11px] text-ink-3">Every SAP request runs with your identity. Changes always require your confirmation.</figcaption>
    </figure>
  );
}
