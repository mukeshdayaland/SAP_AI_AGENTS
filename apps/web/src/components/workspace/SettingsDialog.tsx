'use client';

import { useI18n } from '@/lib/i18n';
import type { SendKey, ThemePref } from '@/lib/prefs';
import { Dialog, cx } from '../ui/primitives';

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string; lang?: string }[]; onChange: (v: T) => void }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-ink">{label}</legend>
      <div className="inline-flex rounded-lg border border-line bg-muted p-0.5" role="radiogroup">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            lang={o.lang}
            aria-checked={value === o.id}
            onClick={() => onChange(o.id)}
            className={cx('rounded-md px-3 py-1.5 text-[12px] font-medium', value === o.id ? 'bg-surface text-ink shadow-soft' : 'text-ink-3 hover:text-ink')}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SettingsDialog({
  open,
  onClose,
  theme,
  onTheme,
  sendKey,
  onSendKey,
}: {
  open: boolean;
  onClose: () => void;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  sendKey: SendKey;
  onSendKey: (k: SendKey) => void;
}) {
  const { t, locale, setLocale } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t('settings.title')}>
      <div className="space-y-6">
        <Segmented
          label={t('settings.language')}
          value={locale}
          onChange={setLocale}
          // Each language is named in itself, so it can be found whatever the current one is.
          options={[
            { id: 'en', label: 'English', lang: 'en' },
            { id: 'ar', label: 'العربية', lang: 'ar' },
          ]}
        />
        <Segmented
          label={t('settings.appearance')}
          value={theme}
          onChange={onTheme}
          options={[
            { id: 'light', label: t('settings.light') },
            { id: 'dark', label: t('settings.dark') },
            { id: 'system', label: t('settings.system') },
          ]}
        />
        <Segmented
          label={t('settings.sendWith')}
          value={sendKey}
          onChange={onSendKey}
          options={[
            { id: 'enter', label: t('settings.enter') },
            { id: 'mod-enter', label: t('settings.modEnter') },
          ]}
        />
      </div>
    </Dialog>
  );
}
