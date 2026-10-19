'use client';

import type { BrowserAction, BrowserActionResult, UIComponent } from '@prowess/contracts';
import { AppWindow, ChevronLeft, ChevronRight, ExternalLink, Hand, Lock, MousePointer2, X } from 'lucide-react';
import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { translateServer, useT } from '@/lib/i18n';
import { Button, IconButton, cx } from '../ui/primitives';
import { boxOf, needsConsent, readPage, typeInto, type Box, type Found } from './fiori-page';

export type FioriGuide = Extract<UIComponent, { type: 'fiori_guide' }>['data'];

/** Lets a guide card open the browser pane without knowing about the workspace layout. */
export const FioriContext = createContext<{ open: (guide: FioriGuide) => void; active?: FioriGuide }>({ open: () => undefined });

export const sameGuide = (a: FioriGuide | null | undefined, b: FioriGuide) => a?.guide === b.guide && a.objectId === b.objectId;

function openWindow(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** The note the conversation keeps of a guide. The steps themselves are shown in the browser pane. */
export function FioriGuideCard({ data }: { data: FioriGuide }) {
  const t = useT();
  const { open, active } = useContext(FioriContext);
  const shown = sameGuide(active, data);
  return (
    <section aria-label={t('fiori.label', { title: translateServer(data.title) })} className="flex flex-wrap items-center gap-3 rounded-area border border-area-sap/60 bg-surface px-4 py-2.5 shadow-soft">
      <AppWindow size={18} aria-hidden className="shrink-0 text-brand" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">
          {translateServer(data.title)}
          {data.objectId && <span className="font-mono font-normal text-ink-2"> · {data.objectId}</span>}
        </p>
        <p className="truncate text-xs text-ink-3">{t(data.url ? 'fiori.beside' : 'fiori.noLaunchpad', { app: data.app })}</p>
      </div>
      <Button size="sm" onClick={() => open(data)} disabled={shown}>
        {t(shown ? 'fiori.openRight' : 'fiori.show')}
      </Button>
    </section>
  );
}

export interface FioriPaneHandle {
  /** Carries out one action of the agent in the page and reports what happened. */
  perform: (action: BrowserAction) => Promise<BrowserActionResult>;
}

interface Spot {
  found: Found;
  box: Box;
  note: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The browser pane: a Fiori app beside the conversation, under the user's own
 * SAP sign-in. When the app is served on the workspace's own address the agent
 * has a cursor in it: it reads the page, points, types and clicks, shows each
 * step next to the element it concerns, and waits for the user before any
 * click that saves. On another address the page is closed to it, and the pane
 * shows the guide's steps instead.
 */
export const FioriPane = forwardRef<FioriPaneHandle, { guide: FioriGuide; onClose: () => void }>(function FioriPane({ guide, onClose }, handle) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const refs = useRef(new Map<string, Found>());
  const loaded = useRef(false);
  const mine = useRef(false);
  const [address, setAddress] = useState(guide.url ?? '');
  const [spot, setSpot] = useState<Spot | null>(null);
  const [consent, setConsent] = useState<{ label: string; answer: (allowed: boolean) => void } | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [step, setStep] = useState(0);
  // Only a page on the workspace's own address can be read and operated.
  const reachable = Boolean(guide.embed && guide.url?.startsWith('/'));
  const framed = guide.embed && guide.url;

  useImperativeHandle(handle, () => ({
    async perform(action) {
      const fail = (message: string): BrowserActionResult => ({ id: action.id, ok: false, message });
      const el = frame.current;
      if (!reachable || !el) return fail('The Fiori page is on an address that cannot be read here. The user follows the steps shown in the pane.');
      if (mine.current) return fail('The user has taken over the browser. Tell them the next step instead of acting.');
      for (let waited = 0; !loaded.current && waited < 15_000; waited += 200) await wait(200);
      if (!loaded.current) return fail('The Fiori page did not load.');

      const snapshot = () => {
        const read = readPage(el);
        refs.current = read.refs;
        return read.page;
      };
      if (action.kind === 'read') {
        // A Fiori app draws itself in stages: the launchpad's bar first, the app's own fields later. Read once the
        // page has stopped changing, or the agent sees the bar alone and takes the app for empty.
        let page = snapshot();
        for (let waited = 0, settled = 0; settled < 2 && waited < 12_000; waited += 500) {
          await wait(500);
          const next = snapshot();
          settled = next.elements.length > 0 && next.elements.length === page.elements.length ? settled + 1 : 0;
          page = next;
        }
        return { id: action.id, ok: true, page };
      }

      const found = refs.current.get(action.ref);
      if (!found?.el.isConnected) return fail('That element is no longer on the page. Read the page again.');
      found.el.scrollIntoView({ block: 'center', inline: 'nearest' });
      setSpot({ found, box: boxOf(found), note: action.note });
      if (action.kind === 'point') return { id: action.id, ok: true };

      await wait(500); // let the user see where the cursor went before anything changes
      if (action.kind === 'type') {
        if (!typeInto(found.el, action.text)) return fail('This field does not take that value: it is read-only, or the value is not one of its options.');
      } else {
        const label = found.el.getAttribute('aria-label') || found.el.textContent?.replace(/\s+/g, ' ').trim() || '';
        if (needsConsent(found.el.getAttribute('role') ?? found.el.tagName.toLowerCase(), label)) {
          const allowed = await new Promise<boolean>((answer) => setConsent({ label: label || t('fiori.thisButton'), answer }));
          setConsent(null);
          if (!allowed) return fail('The user chose to do this step themselves. Wait for them to say it is done.');
        }
        if (mine.current) return fail('The user has taken over the browser.');
        found.el.click();
      }
      await wait(700); // the page answers: a message, a new field, another screen
      return { id: action.id, ok: true, page: snapshot() };
    },
  }));

  // The page scrolls and redraws under the cursor; keep the mark on the element, and drop it when the element goes.
  useEffect(() => {
    if (!spot) return;
    const timer = setInterval(() => {
      if (!spot.found.el.isConnected) return setSpot(null);
      const box = boxOf(spot.found);
      if (box.x !== spot.box.x || box.y !== spot.box.y || box.w !== spot.box.w || box.h !== spot.box.h) setSpot({ ...spot, box });
    }, 300);
    return () => clearInterval(timer);
  }, [spot]);

  const onLoad = () => {
    loaded.current = true;
    if (!reachable) return;
    try {
      const view = frame.current?.contentWindow;
      const show = () => setAddress(`${view?.location.pathname ?? ''}${view?.location.hash ?? ''}`);
      show();
      view?.addEventListener('hashchange', show);
    } catch {
      // the page moved to another address
    }
  };

  const takeOver = (on: boolean) => {
    mine.current = on;
    setTakenOver(on);
    if (on) {
      consent?.answer(false);
      setSpot(null);
    }
  };

  const guideStep = guide.steps[step]!;
  const status = t(takenOver ? 'fiori.inControl' : consent ? 'fiori.waiting' : spot ? 'fiori.showing' : reachable ? 'fiori.ask' : 'fiori.follow');

  return (
    <aside aria-label={t('fiori.label', { title: translateServer(guide.title) })} className={cx('fixed inset-0 z-40 flex shrink-0 flex-col border-s border-line bg-surface lg:static lg:z-auto', framed ? 'lg:w-[min(56vw,960px)]' : 'lg:w-[360px]')}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <AppWindow size={15} aria-hidden className="shrink-0 text-brand" />
        <p className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 font-mono text-xs text-ink-2" title={address}>
          <Lock size={11} aria-hidden className="shrink-0 text-ink-3" />
          <span className="truncate">{address || guide.app}</span>
        </p>
        {guide.url && (
          <IconButton label={t('fiori.newWindow')} onClick={() => openWindow(guide.url!)}>
            <ExternalLink size={15} aria-hidden />
          </IconButton>
        )}
        <IconButton label={t('fiori.close')} onClick={onClose}>
          <X size={15} aria-hidden />
        </IconButton>
      </header>

      <div className="relative min-h-0 flex-1 bg-bg">
        {framed ? (
          <iframe
            ref={frame}
            key={guide.url}
            src={guide.url}
            title={t('fiori.frame', { app: guide.app })}
            onLoad={onLoad}
            className="absolute inset-0 h-full w-full border-0"
            referrerPolicy="no-referrer"
            // A page from another address may run and submit its forms, but cannot navigate the workspace away.
            {...(!reachable && { sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals' })}
          />
        ) : (
          <p className="p-4 text-sm text-ink-2">{t(guide.url ? 'fiori.openFollow' : 'fiori.openInSap', { app: guide.app })}</p>
        )}

        {/* What the agent shows lies over the page and lets every click through to it. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {spot && (
            <>
              <span aria-hidden className="absolute rounded-md ring-2 ring-[var(--brand-secondary)] ring-offset-2 ring-offset-transparent transition-all duration-300" style={{ left: spot.box.x, top: spot.box.y, width: spot.box.w, height: spot.box.h }} />
              <span aria-hidden className="absolute left-0 top-0 transition-transform duration-500 ease-out" style={{ transform: `translate(${spot.box.x + Math.min(spot.box.w / 2, 28)}px, ${spot.box.y + spot.box.h / 2}px)` }}>
                <MousePointer2 size={22} fill="var(--brand-secondary)" stroke="var(--surface, #fff)" strokeWidth={1.5} />
              </span>
            </>
          )}

          {spot ? (
            <div
              role="status"
              className="pointer-events-auto absolute w-[min(300px,calc(100%-16px))] rounded-xl border border-[var(--brand-secondary)] bg-surface px-3 py-2.5 shadow-lift"
              style={{
                left: Math.max(8, Math.min(spot.box.x, (frame.current?.clientWidth ?? 600) - 308)),
                ...(spot.box.y + spot.box.h + 150 < (frame.current?.clientHeight ?? 600) ? { top: spot.box.y + spot.box.h + 14 } : { top: Math.max(8, spot.box.y - 150) }),
              }}
            >
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--brand-secondary)]">
                <MousePointer2 size={11} aria-hidden /> {t('fiori.agent')}
              </p>
              <p className="mt-0.5 text-[13px] text-ink">{spot.note}</p>
              {consent && (
                <div className="mt-2 border-t border-line pt-2">
                  <p className="text-xs text-ink-2">
                    {t('fiori.allowBefore')}
                    <span className="font-semibold text-ink">{consent.label}</span>
                    {t('fiori.allowAfter')}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => consent.answer(true)}>
                      {t('fiori.allow')}
                    </Button>
                    <Button size="sm" onClick={() => consent.answer(false)}>
                      {t('fiori.doIt')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : reachable ? null : (
            // Only where the agent cannot see the page: there the guide's own steps are all the help there is.
            <div className="pointer-events-auto absolute bottom-3 start-3 w-[min(320px,calc(100%-24px))] rounded-xl border border-line bg-surface px-3 py-2.5 shadow-lift">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                {t('fiori.stepOf', { n: step + 1, total: guide.steps.length })}
              </p>
              <p className="mt-0.5 text-sm font-semibold text-ink" aria-live="polite">
                {translateServer(guideStep.title)}
              </p>
              {guideStep.detail && <p className="mt-0.5 text-xs text-ink-2">{translateServer(guideStep.detail)}</p>}
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => setStep(step - 1)} disabled={step === 0}>
                  <ChevronLeft size={14} aria-hidden className="rtl:-scale-x-100" /> {t('fiori.back')}
                </Button>
                <Button size="sm" onClick={() => setStep(step + 1)} disabled={step === guide.steps.length - 1}>
                  {t('fiori.next')} <ChevronRight size={14} aria-hidden className="rtl:-scale-x-100" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-line px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-xs text-ink-3" aria-live="polite">
          {status}
        </p>
        {reachable && (
          <Button size="sm" variant={takenOver ? 'primary' : 'secondary'} onClick={() => takeOver(!takenOver)}>
            <Hand size={14} aria-hidden /> {t(takenOver ? 'fiori.handBack' : 'fiori.takeOver')}
          </Button>
        )}
      </footer>
    </aside>
  );
});
