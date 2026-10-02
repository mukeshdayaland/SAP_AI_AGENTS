'use client';

import type { AttachmentRef, ConversationSummary, PublicError, StarterAction, WorkspaceConfig } from '@prowess/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError} from '@/lib/api';
import { api } from '@/lib/api';
import { prefs, type SendKey, type ThemePref } from '@/lib/prefs';
import { useChat } from '@/lib/use-chat';
import { AssistantMessage, UserMessage } from '../chat/Message';
import { AskContext } from '../sap/card';
import { Button, ProwessMark, Spinner, cx } from '../ui/primitives';
import { Composer, type ComposerHandle } from './Composer';
import { Header } from './Header';
import { Landing } from './Landing';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar } from './Sidebar';

const WINDOW = 60;

function readConversationParam(): string | null {
  const id = new URLSearchParams(window.location.search).get('c');
  return id && /^c_[A-Za-z0-9_-]{16,40}$/.test(id) ? id : null;
}

function writeConversationParam(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('c', id);
  else url.searchParams.delete('c');
  window.history.replaceState(null, '', url);
}

export function Workspace() {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [bootError, setBootError] = useState<PublicError | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [agent, setAgent] = useState('');
  const [tier, setTier] = useState('');
  const [theme, setTheme] = useState<ThemePref>('system');
  const [sendKey, setSendKey] = useState<SendKey>('enter');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const booted = useRef(false);

  const refreshConversations = useCallback(() => {
    api.conversations().then(setConversations, () => undefined);
  }, []);
  const chat = useChat(refreshConversations);

  useEffect(() => {
    setTheme(prefs.theme());
    setSendKey(prefs.sendKey());
    setCollapsed(prefs.sidebarCollapsed());
    void import('../chat/Markdown'); // warm the lazy chunk before the first answer streams
    api.workspace().then(
      (c) => {
        setConfig(c);
        setAgent(c.defaultAgent);
        setTier(c.defaultModelTier);
        refreshConversations();
        const id = readConversationParam();
        booted.current = true;
        if (id) void chat.load(id);
      },
      (err: ApiError) => setBootError(err.error),
    );
  }, []);

  useEffect(() => {
    // Don't clear a deep link (?c=…) before it has been read at boot.
    if (booted.current) writeConversationParam(chat.conversationId);
  }, [chat.conversationId]);

  // Follow the stream unless the user scrolled up to read.
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat.messages]);

  const agentsById = useMemo(() => new Map((config?.agents ?? []).map((a) => [a.id, a])), [config]);

  const send = useCallback(
    (text: string, attachments: AttachmentRef[] = [], agentOverride?: string) => {
      stick.current = true;
      void chat.send(text, { agent: agentOverride ?? agent, modelTier: tier, attachments });
    },
    [chat, agent, tier],
  );

  const ask = useCallback((prompt: string) => send(prompt), [send]);

  const startNew = () => {
    chat.reset();
    setMobileOpen(false);
    setShowAll(false);
    if (config) setAgent(config.defaultAgent);
    requestAnimationFrame(() => composer.current?.focus());
  };

  const select = (id: string) => {
    setMobileOpen(false);
    setShowAll(false);
    stick.current = true;
    void chat.load(id);
  };

  const onStarter = (s: StarterAction) => {
    if (agentsById.has(s.agent)) setAgent(s.agent);
    send(s.prompt, [], s.agent);
  };

  const changeTheme = (t: ThemePref) => {
    prefs.setTheme(t);
    setTheme(t);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        startNew();
      }
      if (e.key === 'Escape' && chat.streaming) chat.stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (bootError) {
    return (
      <main className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <ProwessMark size={44} />
        <p className="max-w-md text-ink">{bootError.message}</p>
        {bootError.reference && <p className="font-mono text-xs text-ink-3">Reference: {bootError.reference}</p>}
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </main>
    );
  }
  if (!config) {
    return (
      <main className="flex min-h-full items-center justify-center" aria-busy="true">
        <Spinner className="h-6 w-6 text-brand" />
        <span className="sr-only">Loading Prowess AI</span>
      </main>
    );
  }

  const messages = showAll ? chat.messages : chat.messages.slice(-WINDOW);
  const hidden = chat.messages.length - messages.length;
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === 'assistant');
  const agentName = (id?: string) => agentsById.get(id ?? agent)?.name ?? 'Prowess AI';

  return (
    <AskContext.Provider value={ask}>
      <a href="#prowess-prompt" className="skip-link">
        Skip to message input
      </a>
      <div className={cx('flex h-full', config.environment === 'PROD' && 'border-t-[3px] border-error')}>
        <Sidebar
          conversations={conversations}
          activeId={chat.conversationId}
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          user={config.user}
          onToggle={() => {
            prefs.setSidebarCollapsed(!collapsed);
            setCollapsed(!collapsed);
          }}
          onCloseMobile={() => setMobileOpen(false)}
          onNew={startNew}
          onSelect={select}
          onRename={async (id, title) => {
            await api.rename(id, title).catch(() => undefined);
            if (id === chat.conversationId) chat.setTitle(title);
            refreshConversations();
          }}
          onDelete={async (id) => {
            await api.remove(id).catch(() => undefined);
            if (id === chat.conversationId) startNew();
            refreshConversations();
          }}
          onSettings={() => setSettingsOpen(true)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            config={config}
            agent={agent}
            tier={tier}
            title={chat.title}
            theme={theme}
            locked={chat.streaming}
            onAgent={setAgent}
            onTier={setTier}
            onTheme={changeTheme}
            onOpenSidebar={() => setMobileOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />

          <main
            ref={scroller}
            id="main"
            className="flex flex-1 flex-col overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {chat.loading ? (
              <div className="flex flex-1 items-center justify-center" aria-busy="true">
                <Spinner className="h-5 w-5 text-brand" />
              </div>
            ) : chat.loadError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-ink">{chat.loadError.message}</p>
                <Button onClick={startNew}>Start a new conversation</Button>
              </div>
            ) : chat.messages.length === 0 ? (
              <Landing config={config} onStarter={onStarter} />
            ) : (
              <div className="mx-auto w-full max-w-3xl flex-1 space-y-7 px-4 py-8" aria-live="off">
                {hidden > 0 && (
                  <div className="text-center">
                    <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
                      Show {hidden} earlier messages
                    </Button>
                  </div>
                )}
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <UserMessage key={m.id} message={m} />
                  ) : (
                    <AssistantMessage
                      key={m.id}
                      message={m}
                      isLast={m.id === lastAssistant?.id && !chat.streaming}
                      technical={config.features.technicalPanel}
                      agentName={agentName(m.agent)}
                      onRegenerate={() => {
                        const idx = chat.messages.findIndex((x) => x.id === m.id);
                        const userMsg = chat.messages
                          .slice(0, idx)
                          .reverse()
                          .find((x) => x.role === 'user');
                        if (userMsg) void chat.send(userMsg.content, { agent: m.agent ?? agent, modelTier: tier, regenerateMessageId: userMsg.id, ...(userMsg.attachments && { attachments: userMsg.attachments }) });
                      }}
                      onRate={(r) => chat.rate(m.id, r)}
                      onConfirmation={chat.resolveConfirmation}
                    />
                  ),
                )}
                <div ref={bottom} />
              </div>
            )}
          </main>

          <div className="shrink-0 bg-gradient-to-t from-bg via-bg to-transparent px-3 pb-3 pt-2 md:px-6">
            <Composer
              ref={composer}
              streaming={chat.streaming}
              attachmentsEnabled={config.features.attachments}
              accept={config.uploads.accept}
              sendKey={sendKey}
              agentLabel={agentName()}
              onSend={(text, attachments) => send(text, attachments)}
              onStop={chat.stop}
            />
          </div>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {chat.streaming ? 'Prowess AI is responding' : lastAssistant?.status === 'complete' ? 'Response complete' : ''}
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        theme={theme}
        onTheme={changeTheme}
        sendKey={sendKey}
        onSendKey={(k) => {
          prefs.setSendKey(k);
          setSendKey(k);
        }}
      />
    </AskContext.Provider>
  );
}
