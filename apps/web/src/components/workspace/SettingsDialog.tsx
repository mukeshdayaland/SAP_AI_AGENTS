'use client';

import type { WorkspaceConfig } from '@prowess/contracts';
import { prefs, type SendKey, type ThemePref } from '@/lib/prefs';
import { Dialog, cx } from '../ui/primitives';

const DEV_USERS = [
  { id: 'alex.morgan@prowess.example', label: 'Alex Morgan — power user (SAP: may release invoices)' },
  { id: 'jordan.lee@prowess.example', label: 'Jordan Lee — standard user' },
  { id: 'sam.rivera@prowess.example', label: 'Sam Rivera — administrator' },
  { id: 'casey.kim@prowess.example', label: 'Casey Kim — auditor' },
];

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
  config,
  theme,
  onTheme,
  sendKey,
  onSendKey,
}: {
  open: boolean;
  onClose: () => void;
  config: WorkspaceConfig;
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
        {config.environment === 'DEV' && (
          <div>
            <label htmlFor="dev-user" className="mb-2 block text-sm font-medium text-ink">
              Development identity
            </label>
            <select
              id="dev-user"
              defaultValue={prefs.devUser() ?? DEV_USERS[0]!.id}
              onChange={(e) => {
                prefs.setDevUser(e.target.value);
                window.location.assign('/');
              }}
              className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink"
            >
              {DEV_USERS.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-ink-3">Only available with development authentication. Production uses corporate SSO.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
