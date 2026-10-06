'use client';

import type { ConversationSummary, UserProfile } from '@prowess/contracts';
import { ChevronsUpDown, CircleHelp, LayoutDashboard, LogOut, MapPin, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { groupConversations } from '@/lib/format';
import { IconButton, Menu, MenuItem, ProwessMark, cx } from '../ui/primitives';

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  collapsed: boolean;
  mobileOpen: boolean;
  user: UserProfile;
  showAdmin: boolean;
  onToggle: () => void;
  onCloseMobile: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
}

function roleLabel(user: UserProfile) {
  if (user.roles.includes('AI_ADMIN')) return 'Administrator';
  if (user.roles.includes('AI_POWER_USER')) return 'Power user';
  if (user.roles.includes('AI_AUDITOR')) return 'Auditor';
  return 'Business user';
}

export function Sidebar(p: Props) {
  const groups = useMemo(() => groupConversations(p.conversations), [p.conversations]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const collapsed = p.collapsed && !p.mobileOpen;
  const initials = p.user.displayName
    .split(' ')
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      {p.mobileOpen && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={p.onCloseMobile} aria-hidden />}
      <nav
        aria-label="Conversations"
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-line bg-surface transition-[width,transform] duration-200 md:static md:translate-x-0',
          p.mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'w-[64px]' : 'w-[272px]',
        )}
      >
        <div className={cx('flex h-14 items-center border-b border-line px-3', collapsed ? 'justify-center' : 'justify-between')}>
          {!collapsed && (
            <div className="flex items-center gap-2.5">
              <ProwessMark size={26} />
              <span className="text-[14px] font-semibold tracking-tight text-ink">Prowess AI</span>
            </div>
          )}
          <span className="hidden md:inline-flex">
            <IconButton label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={p.onToggle}>
              {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </IconButton>
          </span>
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={p.onNew}
            aria-label="New conversation"
            className={cx(
              'flex w-full items-center gap-2 rounded-lg border border-line bg-surface text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand',
              collapsed ? 'h-10 justify-center' : 'h-10 px-3',
            )}
          >
            <Plus size={16} aria-hidden />
            {!collapsed && 'New conversation'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {!collapsed &&
            groups.map((g) => (
              <section key={g.label} className="mt-3 first:mt-1" aria-label={g.label}>
                <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{g.label}</h3>
                <ul>
                  {g.items.map((c) => (
                    <li key={c.id} className="group relative">
                      {editing === c.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (draft.trim()) p.onRename(c.id, draft.trim());
                            setEditing(null);
                          }}
                        >
                          <input
                            autoFocus
                            aria-label="Conversation name"
                            value={draft}
                            maxLength={120}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => setEditing(null)}
                            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                            className="w-full rounded-lg border border-brand bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none"
                          />
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => p.onSelect(c.id)}
                            aria-current={c.id === p.activeId ? 'page' : undefined}
                            className={cx(
                              'w-full truncate rounded-lg py-1.5 pl-2 pr-8 text-left text-sm transition-colors',
                              c.id === p.activeId ? 'bg-brand-soft font-semibold text-ink shadow-[inset_3px_0_0_var(--brand-primary)]' : 'text-ink-2 hover:bg-muted hover:text-ink',
                            )}
                          >
                            {c.title}
                          </button>
                          <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                            <Menu label={`Options for ${c.title}`} trigger={<MoreHorizontal size={15} className="text-ink-3" />}>
                              {(close) => (
                                <>
                                  <MenuItem
                                    onSelect={() => {
                                      setDraft(c.title);
                                      setEditing(c.id);
                                      close();
                                    }}
                                  >
                                    <Pencil size={14} /> Rename
                                  </MenuItem>
                                  <MenuItem
                                    danger
                                    onSelect={() => {
                                      close();
                                      if (window.confirm(`Delete “${c.title}”? This cannot be undone.`)) p.onDelete(c.id);
                                    }}
                                  >
                                    <Trash2 size={14} /> Delete
                                  </MenuItem>
                                </>
                              )}
                            </Menu>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          {!collapsed && !groups.length && <p className="px-2 pt-2 text-[12px] text-ink-3">Your conversations will appear here.</p>}
        </div>

        <div className="border-t border-line p-2">
          <Menu
            label="Account"
            side="top"
            align="left"
            triggerClassName={cx(
              'flex w-full items-center gap-2.5 rounded-lg border border-transparent text-left transition-colors hover:border-line hover:bg-muted aria-expanded:border-line aria-expanded:bg-muted',
              collapsed ? 'justify-center p-1.5' : 'px-2 py-2',
            )}
            trigger={
              <>
                <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-on-brand">
                  {initials}
                </span>
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{p.user.displayName}</span>
                      <span className="block truncate text-xs text-ink-3">{roleLabel(p.user)}</span>
                    </span>
                    <ChevronsUpDown size={15} aria-hidden className="shrink-0 text-ink-3" />
                  </>
                )}
              </>
            }
          >
            {(close) => (
              <>
                <div className="border-b border-line px-2.5 pb-2 pt-1.5">
                  <p className="truncate text-sm font-medium text-ink">{p.user.displayName}</p>
                  <p className="truncate text-xs text-ink-3">{p.user.email ?? p.user.id}</p>
                </div>
                <div className="pt-1">
                  <MenuItem
                    onSelect={() => {
                      close();
                      p.onSettings();
                    }}
                  >
                    <Settings size={15} /> Settings
                  </MenuItem>
                  <MenuItem href="/vendors/">
                    <MapPin size={15} /> Vendor map
                  </MenuItem>
                  <MenuItem href="/help/">
                    <CircleHelp size={15} /> Help and my activity
                  </MenuItem>
                  {p.showAdmin && (
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
      </nav>
    </>
  );
}
