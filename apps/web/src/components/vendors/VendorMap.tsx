/// <reference types="google.maps" />
'use client';

import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import { ArrowLeft, MapPin, Maximize2, Minimize2, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ApiError } from '@/lib/api';
import { api } from '@/lib/api';
import { translateServer, useDocumentTitle, useT, type MessageKey, type T } from '@/lib/i18n';
import { Badge, ProwessMark, Spinner, cx } from '../ui/primitives';
import { groupSites, siteKeyOf, type Place, type Site } from './sites';

const LIST_LIMIT = 200;
const PRECISION: Record<Place['precision'], MessageKey> = { street: 'map.precision.street', city: 'map.precision.city', approximate: 'map.precision.approximate' };
/** Sites named under an employee map as its hotspots. */
const HOTSPOTS = 5;

interface MapData {
  places: Place[];
  total: number;
  excluded: number;
  system: string;
  mock: boolean;
  maps?: { apiKey: string; mapId: string } | undefined;
}

/** What the map shows. Vendors and employees share the map; only the words (`map.<kind>.*`), the source and the pin differ. */
interface Kind {
  /** Pins drawn as heat spots that grow with the number of people, instead of numbered dots. */
  hotspot: boolean;
  load: () => Promise<MapData>;
}

const KINDS = {
  vendors: {
    hotspot: false,
    load: () => api.vendorLocations().then(({ vendors, ...rest }) => ({ ...rest, places: vendors })),
  },
  employees: {
    hotspot: true,
    load: () => api.employeeLocations().then(({ employees, ...rest }) => ({ ...rest, places: employees })),
  },
} satisfies Record<string, Kind>;
type KindId = keyof typeof KINDS;

/** One of a kind's texts, e.g. `word(t, 'vendors', 'count', { count: 3 })` for "3 vendors". */
const word = (t: T, kind: KindId, name: 'title' | 'count' | 'search' | 'searchLabel' | 'loading' | 'none' | 'without' | 'noMatch' | 'mapOf', vars?: Record<string, number>) =>
  t(`map.${kind}.${name}`, vars);

let optionsSet = false;
const loaded: Partial<Record<KindId, Promise<MapData>>> = {};

/** The places of one kind, read once per page load and shared by every map on the page. */
function useLocations(kind: KindId) {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (loaded[kind] ??= KINDS[kind].load()).then(setData, (e: ApiError) => {
      delete loaded[kind];
      setError(translateServer(e.message));
    });
  }, [kind]);
  return { data, error };
}

/**
 * Only one map card in a conversation is live: the newest, or the one the user
 * reopened. Earlier cards collapse to their header so the chat holds one map.
 */
const cards: string[] = [];
let activeCard: string | null = null;
const cardListeners = new Set<() => void>();
function setActiveCard(id: string | null) {
  activeCard = id;
  for (const notify of cardListeners) notify();
}
function useIsActiveCard(): [boolean, () => void] {
  const id = useId();
  useEffect(() => {
    cards.push(id);
    setActiveCard(id);
    return () => {
      cards.splice(cards.indexOf(id), 1);
      if (activeCard === id) setActiveCard(cards.at(-1) ?? null);
    };
  }, [id]);
  const active = useSyncExternalStore(
    (notify) => {
      cardListeners.add(notify);
      return () => cardListeners.delete(notify);
    },
    () => activeCard === id,
    () => false,
  );
  return [active, () => setActiveCard(id)];
}

/** A round pin showing how many places it stands for; dashed when the place is only approximate. */
function pin(count: number, approximate: boolean, cluster = false): HTMLElement {
  const size = Math.round(Math.min(56, 22 + Math.sqrt(count) * 3));
  const look = approximate
    ? 'background:rgb(0 112 242 / .15);color:#0040b0;border:2px dashed #0070f2'
    : `background:${cluster ? '#0040b0' : '#0070f2'};color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgb(0 0 0 / .3)`;
  const el = document.createElement('div');
  el.textContent = count > 1 ? String(count) : '';
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:600 11px system-ui,sans-serif;cursor:pointer;transform:translateY(50%);${look}`;
  return el;
}

/**
 * A heat spot: a glow whose size and warmth grow with the number of people at
 * the place, relative to the busiest place on the map, with the headcount at its core.
 */
function hotspot(count: number, max: number): HTMLElement {
  const share = max > 0 ? Math.sqrt(count / max) : 1;
  const size = Math.round(44 + share * 76);
  // From amber for the quietest place to deep red for the busiest.
  const hue = Math.round(42 - share * 38);
  const el = document.createElement('div');
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;transform:translateY(50%);background:radial-gradient(circle,hsl(${hue} 92% 48% / .9) 0%,hsl(${hue} 92% 52% / .55) 34%,hsl(${hue + 10} 95% 58% / .22) 58%,hsl(${hue + 10} 95% 60% / 0) 72%)`;
  const core = document.createElement('span');
  core.textContent = String(count);
  core.style.cssText = 'min-width:24px;height:24px;padding:0 6px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#fff;color:#7a1d0a;font:700 12px system-ui,sans-serif;box-shadow:0 1px 4px rgb(0 0 0 / .35)';
  el.append(core);
  return el;
}

/** The Google map itself: one pin per site, clustered when zoomed out. */
function MapCanvas({ kind, maps, sites, focus, onSelect }: { kind: KindId; maps: MapData['maps']; sites: Site[]; focus?: Site | undefined; onSelect: (key: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const t = useT();
  const [failure, setFailure] = useState<string | null>(null);
  const words = KINDS[kind];

  useEffect(() => {
    if (!maps || !el.current || !sites.length) return;
    let cancelled = false;
    let clusterer: MarkerClusterer | undefined;
    // Google calls this when the key is rejected, for example by its website restriction.
    (window as { gm_authFailure?: () => void }).gm_authFailure = () => setFailure(t('map.keyRejected'));
    (async () => {
      if (!optionsSet) {
        setOptions({ key: maps.apiKey, v: 'weekly' });
        optionsSet = true;
      }
      const [{ Map: GoogleMap }, { AdvancedMarkerElement }, { LatLngBounds }] = await Promise.all([importLibrary('maps'), importLibrary('marker'), importLibrary('core')]);
      if (cancelled || !el.current) return;
      const gmap = new GoogleMap(el.current, { mapId: maps.mapId, center: { lat: 20, lng: 78 }, zoom: 4, streetViewControl: false, mapTypeControl: false, fullscreenControl: false });
      map.current = gmap;
      const counts = new Map<unknown, number>();
      const bounds = new LatLngBounds();
      const busiest = sites.reduce((n, s) => Math.max(n, s.vendors.length), 0);
      const total = sites.reduce((n, s) => n + s.vendors.length, 0);
      const markers = sites.map((site) => {
        const position = { lat: site.lat, lng: site.lng };
        const count = site.vendors.length;
        const title = count === 1 ? site.vendors[0]!.name : word(t, kind, 'count', { count });
        const content = words.hotspot ? hotspot(count, busiest) : pin(count, site.approximate);
        const marker = new AdvancedMarkerElement({ position, content, title, gmpClickable: true, ...(words.hotspot && { zIndex: count }) });
        marker.addListener('click', () => select.current(site.key));
        counts.set(marker, count);
        bounds.extend(position);
        return marker;
      });
      clusterer = new MarkerClusterer({
        map: gmap,
        markers,
        renderer: {
          // A cluster counts places, not pins: one pin can stand for hundreds of them.
          render: ({ position, markers: members }) => {
            const n = (members ?? []).reduce((sum, m) => sum + (counts.get(m) ?? 1), 0);
            return new AdvancedMarkerElement({ position, content: words.hotspot ? hotspot(n, total) : pin(n, false, true), title: word(t, kind, 'count', { count: n }), zIndex: 1000 + n });
          },
        },
      });
      if (sites.length === 1) {
        gmap.setCenter(bounds.getCenter());
        gmap.setZoom(11);
      } else gmap.fitBounds(bounds, 40);
    })().catch(() => setFailure(t('map.loadFailed')));
    return () => {
      cancelled = true;
      clusterer?.clearMarkers();
      map.current = null;
    };
  }, [maps, sites, words, kind, t]);

  useEffect(() => {
    if (!focus || !map.current) return;
    map.current.panTo({ lat: focus.lat, lng: focus.lng });
    if ((map.current.getZoom() ?? 0) < 12) map.current.setZoom(12);
  }, [focus]);

  if (!maps || failure) {
    return <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-2">{failure ?? t('map.notSetUp')}</p>;
  }
  return <div ref={el} className="absolute inset-0" aria-label={word(t, kind, 'mapOf')} role="application" />;
}

/** Map with the list beside it: the page view, and the maximized view in the chat. */
function Explorer({ kind, maps, places }: { kind: KindId; maps: MapData['maps']; places: Place[] }) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const sites = useMemo(() => groupSites(places), [places]);
  const site = useMemo(() => sites.find((s) => s.key === selected), [sites, selected]);
  const q = query.trim().toLowerCase();
  const listed = useMemo(() => {
    const pool = site ? site.vendors : places;
    return q ? pool.filter((v) => `${v.name} ${v.id} ${v.address}`.toLowerCase().includes(q)) : pool;
  }, [site, places, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="relative min-h-[40vh] flex-1 bg-muted">
        <MapCanvas kind={kind} maps={maps} sites={sites} focus={site} onSelect={setSelected} />
      </div>
      <aside className="flex max-h-[50vh] w-full shrink-0 flex-col border-t border-line bg-surface md:max-h-none md:w-80 md:border-s md:border-t-0">
        <div className="border-b border-line p-3">
          {site && (
            <div className="mb-2 flex items-center gap-2 text-[12px] text-ink">
              <span className="font-medium">
                {t('map.atLocation', { places: word(t, kind, 'count', { count: site.vendors.length }) })}
              </span>
              <button type="button" onClick={() => setSelected(null)} className="ms-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-2 hover:bg-muted hover:text-ink">
                <X size={13} aria-hidden /> {t('map.showAll')}
              </button>
            </div>
          )}
          <label className="relative block">
            <span className="sr-only">{word(t, kind, 'searchLabel')}</span>
            <Search size={14} aria-hidden className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={word(t, kind, 'search')}
              className="h-9 w-full rounded-lg border border-line bg-surface ps-8 pe-2 text-[13px] text-ink placeholder:text-ink-3"
            />
          </label>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {listed.slice(0, LIST_LIMIT).map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => setSelected(siteKeyOf(v))} className="block w-full border-b border-line px-3 py-2 text-start hover:bg-muted">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{v.name}</span>
                  {v.isCustomer && <Badge tone="info">{t('map.alsoCustomer')}</Badge>}
                </span>
                <span className="block truncate text-[12px] text-ink-2">
                  {v.id} · {v.address}
                </span>
                {kind === 'vendors' && <span className="text-[11px] text-ink-3">{t(PRECISION[v.precision])}</span>}
              </button>
            </li>
          ))}
          {!listed.length && <li className="px-3 py-6 text-center text-[13px] text-ink-2">{word(t, kind, 'noMatch')}</li>}
          {listed.length > LIST_LIMIT && (
            <li className="px-3 py-3 text-center text-[12px] text-ink-3">
              {t('map.showing', { limit: LIST_LIMIT, count: listed.length })}
            </li>
          )}
        </ul>
      </aside>
    </div>
  );
}

/** The vendor map as a page of its own. */
export function VendorMap() {
  const t = useT();
  useDocumentTitle('map.vendors.title');
  const { data, error } = useLocations('vendors');

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="max-w-md text-sm text-ink">{error}</p>
        <a href="/" className="text-sm text-brand hover:underline">
          {t('map.back')}
        </a>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner className="h-6 w-6 text-brand" />
        <p className="text-sm text-ink-2">{t('map.reading')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="brand-bar flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <a href="/" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-muted hover:text-ink">
          <ArrowLeft size={15} aria-hidden className="rtl:-scale-x-100" /> {t('common.workspace')}
        </a>
        <ProwessMark size={24} />
        <h1 className="text-[14px] font-semibold text-ink">{t('map.vendors.title')}</h1>
        <p className="ms-auto text-end text-[12px] text-ink-2">
          {t('map.pageSummary', { placed: data.places.length, total: data.total, excluded: data.excluded, system: data.system })}
          {data.mock && ` ${t('common.mock')}`}
        </p>
      </header>
      <Explorer kind="vendors" maps={data.maps} places={data.places} />
    </div>
  );
}

/**
 * A map inside a chat answer. Starts minimized as a small map in the message;
 * maximizing opens the map with the list over the whole window.
 */
function MapCard({ kind, title, expected, keep }: { kind: KindId; title: string; expected: number; keep: (place: Place) => boolean }) {
  const t = useT();
  const { data, error } = useLocations(kind);
  const [maximized, setMaximized] = useState(false);
  const [active, activate] = useIsActiveCard();
  const dialog = useRef<HTMLDialogElement>(null);
  const words = KINDS[kind];

  const places = useMemo(() => (data?.places ?? []).filter(keep), [data, keep]);
  const sites = useMemo(() => groupSites(places), [places]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (maximized && !d.open) d.showModal();
    if (!maximized && d.open) d.close();
  }, [maximized]);

  return (
    <section aria-label={title} className="overflow-hidden rounded-area border border-area-sap/60 bg-surface shadow-soft">
      <header className="flex items-center gap-3 border-b border-area-sap/25 bg-area-sap-fill px-4 py-3">
        <MapPin size={18} aria-hidden className="shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{word(t, kind, 'title')}</p>
          <p className="truncate text-[14px] font-semibold text-ink">{translateServer(title)}</p>
        </div>
        {!active && (
          <button type="button" onClick={activate} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink hover:bg-muted">
            <MapPin size={13} aria-hidden /> {t('map.showMap')}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            activate();
            setMaximized(true);
          }}
          disabled={!data}
          className="inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-surface px-2.5 py-1 text-xs font-semibold text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
        >
          <Maximize2 size={13} aria-hidden /> {t('map.maximize')}
        </button>
      </header>

      <div className={cx('relative bg-muted', words.hotspot ? 'h-80' : 'h-64', !active && 'hidden')}>
        {error ? (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-2">{error}</p>
        ) : !data ? (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-ink-2">
            <Spinner className="h-4 w-4 text-brand" /> {word(t, kind, 'loading')}
          </p>
        ) : !places.length ? (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-2">{word(t, kind, 'none')}</p>
        ) : (
          // The small map is hidden while the large one is open, so only one of them is live.
          active && !maximized && <MapCanvas kind={kind} maps={data.maps} sites={sites} onSelect={() => setMaximized(true)} />
        )}
      </div>

      {data && words.hotspot && sites.length > 0 && (
        <ol className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-4 py-2.5" aria-label={t('map.hotspots')}>
          {sites.slice(0, HOTSPOTS).map((s) => (
            <li key={s.key} className="text-[12px] text-ink-2">
              <span className="font-semibold text-ink">{s.vendors.length}</span> {s.vendors[0]!.location || t('map.unnamed')}
            </li>
          ))}
          {sites.length > HOTSPOTS && <li className="text-[12px] text-ink-3">{t('map.more', { count: sites.length - HOTSPOTS })}</li>}
        </ol>
      )}

      {data && (
        <p className="border-t border-line px-4 py-2 text-[12px] text-ink-2">
          {t('map.placed', { placed: places.length, expected: word(t, kind, 'count', { count: expected }), locations: t('map.locations', { count: sites.length }) })}
          {expected > places.length && ` · ${word(t, kind, 'without', { count: expected - places.length })}`}
        </p>
      )}

      <dialog
        ref={dialog}
        aria-label={title}
        onClose={() => setMaximized(false)}
        className={cx('m-auto h-[calc(100dvh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none overflow-hidden rounded-area border border-line bg-surface p-0 text-ink shadow-lift backdrop:bg-black/40', maximized && 'flex flex-col')}
      >
        {maximized && data && (
          <>
            <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
              <MapPin size={16} aria-hidden className="text-brand" />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{translateServer(title)}</h2>
              <span className="hidden text-[12px] text-ink-2 sm:inline">
                {word(t, kind, 'count', { count: places.length })} · {data.system}
                {data.mock && ` ${t('common.mock')}`}
              </span>
              <button type="button" onClick={() => setMaximized(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink hover:bg-muted">
                <Minimize2 size={13} aria-hidden /> {t('map.minimize')}
              </button>
            </div>
            <Explorer kind={kind} maps={data.maps} places={places} />
          </>
        )}
      </dialog>
    </section>
  );
}

export function VendorMapCard({ data: card }: { data: { title: string; vendors: number; country?: string | undefined; city?: string | undefined } }) {
  const keep = useMemo(() => {
    const city = card.city?.toLowerCase();
    return (v: Place) => (!card.country || v.country === card.country) && (!city || v.address.toLowerCase().includes(city));
  }, [card.country, card.city]);
  return <MapCard kind="vendors" title={card.title} expected={card.vendors} keep={keep} />;
}

/** Employees by work location, drawn as hotspots: the more people work at a place, the larger and warmer its spot. */
export function EmployeeMapCard({ data: card }: { data: { title: string; employees: number; location?: string | undefined } }) {
  const keep = useMemo(() => {
    const wanted = card.location?.toLowerCase();
    return (e: Place) => !wanted || `${e.location ?? ''} ${e.address}`.toLowerCase().includes(wanted);
  }, [card.location]);
  return <MapCard kind="employees" title={card.title} expected={card.employees} keep={keep} />;
}
