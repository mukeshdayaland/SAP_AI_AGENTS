'use client';

import type { SendKey, ThemePref } from '@/lib/prefs';
import { Dialog, cx } from '../ui/primitives';

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-ink">{label}</legend>
      <div className="inline-flex rounded-lg border border-line bg-muted p-0.5" role="radiogroup">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            onClick={() => onChange(o.id)}
            className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium', value === o.id ? 'bg-surface text-ink shadow-soft' : 'text-ink-3 hover:text-ink')}
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
  return (
    <Dialog open={open} onClose={onClose} title="Settings">
      <div className="space-y-6">
        <Segmented
          label="Appearance"
          value={theme}
          onChange={onTheme}
          options={[
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
            { id: 'system', label: 'System' },
          ]}
        />
        <Segmented
          label="Send message with"
          value={sendKey}
          onChange={onSendKey}
          options={[
            { id: 'enter', label: 'Enter' },
            { id: 'mod-enter', label: 'Ctrl/⌘ + Enter' },
          ]}
        />
      </div>
    </Dialog>
  );
}
