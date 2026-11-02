'use client';

import type { ConfirmationRequest, MessageDTO } from '@prowess/contracts';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import type { ApiError} from '@/lib/api';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { translateServer, useT, type MessageKey } from '@/lib/i18n';
import { Badge, Button, EnvironmentBadge, cx } from '../ui/primitives';

const STATUS_LABEL: Record<ConfirmationRequest['status'], MessageKey> = {
  pending: 'confirm.pending',
  confirmed: 'confirm.confirmed',
  completed: 'confirm.completed',
  failed: 'confirm.failed',
  cancelled: 'confirm.cancelled',
  expired: 'confirm.expired',
};

/**
 * Human-in-the-loop gate for SAP changes. The only way a write executes.
 * Production changes require an explicit acknowledgement checkbox so a user
 * can never confirm a PROD change believing they are in QA.
 */
export function ConfirmationCard({
  confirmation,
  onResolved,
}: {
  confirmation: ConfirmationRequest;
  onResolved: (c: ConfirmationRequest, messages?: MessageDTO[]) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const titleId = useId();
  const isProd = confirmation.environment === 'PROD';
  const pending = confirmation.status === 'pending';
  const expired = pending && new Date(confirmation.expiresAt).getTime() < Date.now();

  async function act(kind: 'confirm' | 'cancel') {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'confirm') {
        const res = await api.confirm(confirmation.id, isProd ? 'PROD' : undefined);
        onResolved(res.confirmation, [res.message, ...(res.followUp ?? [])]);
      } else {
        const res = await api.cancel(confirmation.id);
        onResolved(res.confirmation, res.followUp);
      }
    } catch (err) {
      const e = (err as ApiError).error;
      setError(`${e?.message ? translateServer(e.message) : t('confirm.couldNot')}${e?.reference ? ` ${t('common.reference', { reference: e.reference })}` : ''}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      role="group"
      aria-labelledby={titleId}
      className={cx('overflow-hidden rounded-area border-2 bg-surface shadow-soft', isProd ? 'border-error' : 'border-warning')}
    >
      <header className={cx('flex items-center justify-between gap-3 border-b px-4 py-2.5', isProd ? 'border-error/30 bg-error-soft' : 'border-warning/30 bg-warning-soft')}>
        <h4 id={titleId} className="flex items-center gap-2 text-sm font-bold text-ink">
          <ShieldCheck size={16} aria-hidden className={isProd ? 'text-error' : 'text-warning'} />
          {t('confirm.title')}
        </h4>
        <div className="flex items-center gap-2">
          <Badge tone={confirmation.risk === 'HIGH_IMPACT' ? 'critical' : confirmation.risk === 'BUSINESS_WRITE' ? 'warning' : 'info'}>
            {t(`risk.${confirmation.risk}`)}
          </Badge>
          <EnvironmentBadge env={confirmation.environment} />
        </div>
      </header>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-3 text-sm sm:grid-cols-[140px_1fr]">
        <dt className="text-ink-3">{t('confirm.action')}</dt>
        <dd className="font-medium text-ink">{translateServer(confirmation.action)}</dd>
        <dt className="text-ink-3">{t('confirm.target')}</dt>
        <dd className="text-ink">
          <span className="font-mono">{confirmation.targetSystem}</span>
          {isProd && <span className="ms-2 font-semibold text-error">{t('confirm.production')}</span>}
        </dd>
        <dt className="text-ink-3">{translateServer(confirmation.businessObject.type)}</dt>
        <dd className="font-mono text-ink">{confirmation.businessObject.id}</dd>
        <dt className="text-ink-3">{t('confirm.change')}</dt>
        <dd className="text-ink">{confirmation.proposedChange}</dd>
        <dt className="text-ink-3">{t('confirm.impact')}</dt>
        <dd className="flex gap-2 text-ink">
          <AlertTriangle size={15} aria-hidden className="mt-0.5 shrink-0 text-warning" />
          {confirmation.impact}
        </dd>
      </dl>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
        {pending && !expired ? (
          <>
            {isProd ? (
              <label className="flex items-center gap-2 text-[12px] text-ink">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="h-4 w-4 accent-[var(--error)]" />
                {t('confirm.ackBefore')}
                <strong>{t('confirm.ackWord')}</strong>
                {t('confirm.ackAfter')}
              </label>
            ) : (
              <p className="text-xs text-ink-3">{t('confirm.expires', { time: formatTime(confirmation.expiresAt) })}</p>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => act('cancel')} disabled={busy !== null}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant={isProd ? 'danger' : 'primary'} onClick={() => act('confirm')} disabled={busy !== null || (isProd && !ack)}>
                {t(busy === 'confirm' ? 'confirm.executing' : 'confirm.confirm')}
              </Button>
            </div>
          </>
        ) : (
          <p className={cx('text-sm font-medium', confirmation.status === 'completed' ? 'text-success' : confirmation.status === 'failed' ? 'text-error' : 'text-ink-2')}>
            {t(expired ? 'confirm.expiredAsk' : STATUS_LABEL[confirmation.status])}
          </p>
        )}
      </footer>
      {error && (
        <p role="alert" className="border-t border-line bg-error-soft px-4 py-2 text-[12px] text-error">
          {error}
        </p>
      )}
    </section>
  );
}
