'use client';

import type { ConversationSummary, UserProfile } from '@prowess/contracts';
import { ChevronsUpDown, CircleHelp, LayoutDashboard, LogOut, MapPin, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { groupConversations } from '@/lib/format';
import { IconButton, Menu, MenuItem, ProwessMark, cx } from '../ui/primitives';
import { brand } from '@/lib/brand';
import { useT, type MessageKey } from '@/lib/i18n';

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

function roleLabel(user: UserProfile): MessageKey {
  if (user.roles.includes('AI_ADMIN')) return 'role.admin';
  if (user.roles.includes('AI_POWER_USER')) return 'role.power';
  if (user.roles.includes('AI_AUDITOR')) return 'role.auditor';
  return 'role.business';
}

export function Sidebar(p: Props) {
  const t = useT();
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
        aria-label={t('sidebar.conversations')}
        className={cx(
          'brand-nav fixed inset-y-0 start-0 z-40 flex flex-col border-e border-line bg-surface transition-[width,transform] duration-200 md:static',
          // Off-screen on small screens only: past the left edge in English, past the right edge in Arabic.
          !p.mobileOpen && 'max-md:-translate-x-full max-md:rtl:translate-x-full',
          collapsed ? 'w-[64px]' : 'w-[272px]',
        )}
      >
        <div className={cx('flex h-14 items-center border-b border-line px-3', collapsed ? 'justify-center' : 'justify-between')}>
          {/* The mark stays when the sidebar is collapsed; only the name goes. */}
          <div className="flex items-center gap-2.5">
            <ProwessMark size={collapsed ? 30 : 26} />
            {!collapsed && <span className="text-[14px] font-semibold tracking-tight text-ink">{brand.name}</span>}
          </div>
          {!collapsed && (
            <span className="hidden md:inline-flex">
              <IconButton label={t('sidebar.collapse')} onClick={p.onToggle}>
                <PanelLeftClose size={17} className="rtl:-scale-x-100" />
              </IconButton>
            </span>
          )}
        </div>

        <div className={cx('p-3', collapsed && 'flex flex-col items-center gap-2')}>
          {collapsed && (
            <span className="hidden md:inline-flex">
              <IconButton label={t('sidebar.expand')} onClick={p.onToggle}>
                <PanelLeftOpen size={17} className="rtl:-scale-x-100" />
              </IconButton>
            </span>
          )}
          <button
            type="button"
            onClick={p.onNew}
            aria-label={t('sidebar.new')}
            className={cx(
              'flex w-full items-center gap-2 rounded-lg border border-line bg-surface text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand',
              collapsed ? 'h-10 justify-center' : 'h-10 px-3',
            )}
          >
            <Plus size={16} aria-hidden />
            {!collapsed && t('sidebar.new')}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {!collapsed &&
            groups.map((g) => (
              <section key={g.id} className="mt-3 first:mt-1" aria-label={t(`sidebar.${g.id}`)}>
                <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t(`sidebar.${g.id}`)}</h3>
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
                            aria-label={t('sidebar.name')}
                            dir="auto"
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
                              'w-full truncate rounded-lg py-1.5 ps-2 pe-8 text-start text-sm transition-colors',
                              c.id === p.activeId ? 'bg-brand-soft font-semibold text-ink shadow-[inset_3px_0_0_var(--brand-primary)] rtl:shadow-[inset_-3px_0_0_var(--brand-primary)]' : 'text-ink-2 hover:bg-muted hover:text-ink',
                            )}
                          >
                            <bdi>{c.title}</bdi>
                          </button>
                          <div className="absolute end-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                            <Menu label={t('sidebar.options', { title: c.title })} trigger={<MoreHorizontal size={15} className="text-ink-3" />}>
                              {(close) => (
                                <>
                                  <MenuItem
                                    onSelect={() => {
                                      setDraft(c.title);
                                      setEditing(c.id);
                                      close();
                                    }}
                                  >
                                    <Pencil size={14} /> {t('sidebar.rename')}
                                  </MenuItem>
                                  <MenuItem
                                    danger
                                    onSelect={() => {
                                      close();
                                      if (window.confirm(t('sidebar.confirmDelete', { title: c.title }))) p.onDelete(c.id);
                                    }}
                                  >
                                    <Trash2 size={14} /> {t('sidebar.delete')}
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
          {!collapsed && !groups.length && <p className="px-2 pt-2 text-[12px] text-ink-3">{t('sidebar.empty')}</p>}
        </div>

        <div className="border-t border-line p-2">
          <Menu
            label={t('sidebar.account')}
            side="top"
            align="start"
            triggerClassName={cx(
              'flex w-full items-center gap-2.5 rounded-lg border border-transparent text-start transition-colors hover:border-line hover:bg-muted aria-expanded:border-line aria-expanded:bg-muted',
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
                      <span className="block truncate text-xs text-ink-3">{t(roleLabel(p.user))}</span>
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
                    <Settings size={15} /> {t('sidebar.settings')}
                  </MenuItem>
                  <MenuItem href="/vendors/">
                    <MapPin size={15} /> {t('sidebar.vendorMap')}
                  </MenuItem>
                  <MenuItem href="/help/">
                    <CircleHelp size={15} /> {t('sidebar.help')}
                  </MenuItem>
                  {p.showAdmin && (
                    <MenuItem href="/admin/">
                      <LayoutDashboard size={15} /> {t('sidebar.admin')}
                    </MenuItem>
                  )}
                  <MenuItem href="/logout">
                    <LogOut size={15} className="rtl:-scale-x-100" /> {t('sidebar.signOut')}
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
