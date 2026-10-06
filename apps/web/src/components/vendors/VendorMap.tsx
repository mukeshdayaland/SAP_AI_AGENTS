/// <reference types="google.maps" />
'use client';

import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import type { VendorLocation, VendorMap as VendorMapData } from '@prowess/contracts';
import { ArrowLeft, MapPin, Maximize2, Minimize2, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ApiError } from '@/lib/api';
import { api } from '@/lib/api';
import { Badge, ProwessMark, Spinner, cx } from '../ui/primitives';
import { groupSites, siteKeyOf, type Site } from './sites';

const LIST_LIMIT = 200;
const PRECISION: Record<VendorLocation['precision'], string> = { street: 'street', city: 'city', approximate: 'postal code or state only' };

let optionsSet = false;
let loaded: Promise<VendorMapData> | undefined;

/** The vendor locations, read once per page load and shared by every map on the page. */
export function useVendorLocations() {
  const [data, setData] = useState<VendorMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loaded ??= api.vendorLocations();
    loaded.then(setData, (e: ApiError) => {
      loaded = undefined;
      setError(e.message);
    });
  }, []);
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

/** A round pin showing how many vendors it stands for; dashed when the place is only approximate. */
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

/** The Google map itself: one pin per site, clustered when zoomed out. */
function MapCanvas({ maps, sites, focus, onSelect }: { maps: VendorMapData['maps']; sites: Site[]; focus?: Site | undefined; onSelect: (key: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!maps || !el.current || !sites.length) return;
    let cancelled = false;
    let clusterer: MarkerClusterer | undefined;
    // Google calls this when the key is rejected, for example by its website restriction.
    (window as { gm_authFailure?: () => void }).gm_authFailure = () => setFailure('Google Maps rejected the map key. Check the key and its website restriction.');
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
      const markers = sites.map((site) => {
        const position = { lat: site.lat, lng: site.lng };
        const title = site.vendors.length === 1 ? site.vendors[0]!.name : `${site.vendors.length} vendors`;
        const marker = new AdvancedMarkerElement({ position, content: pin(site.vendors.length, site.approximate), title, gmpClickable: true });
        marker.addListener('click', () => select.current(site.key));
        counts.set(marker, site.vendors.length);
        bounds.extend(position);
        return marker;
      });
      clusterer = new MarkerClusterer({
        map: gmap,
        markers,
        renderer: {
          // A cluster counts vendors, not pins: one pin can stand for hundreds of vendors.
          render: ({ position, markers: members }) => {
            const vendors = (members ?? []).reduce((n, m) => n + (counts.get(m) ?? 1), 0);
            return new AdvancedMarkerElement({ position, content: pin(vendors, false, true), title: `${vendors} vendors`, zIndex: 1000 + vendors });
          },
        },
      });
      if (sites.length === 1) {
        gmap.setCenter(bounds.getCenter());
        gmap.setZoom(11);
      } else gmap.fitBounds(bounds, 40);
    })().catch(() => setFailure('Google Maps could not be loaded.'));
    return () => {
      cancelled = true;
      clusterer?.clearMarkers();
      map.current = null;
    };
  }, [maps, sites]);

  useEffect(() => {
    if (!focus || !map.current) return;
    map.current.panTo({ lat: focus.lat, lng: focus.lng });
    if ((map.current.getZoom() ?? 0) < 12) map.current.setZoom(12);
  }, [focus]);

  if (!maps || failure) {
    return <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-2">{failure ?? 'The map key or map ID is not set up, so only the list is shown.'}</p>;
  }
  return <div ref={el} className="absolute inset-0" aria-label="Map of vendor locations" role="application" />;
}

/** Map with the vendor list beside it: the page view, and the maximized view in the chat. */
function VendorExplorer({ maps, vendors }: { maps: VendorMapData['maps']; vendors: VendorLocation[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const sites = useMemo(() => groupSites(vendors), [vendors]);
  const site = useMemo(() => sites.find((s) => s.key === selected), [sites, selected]);
  const q = query.trim().toLowerCase();
  const listed = useMemo(() => {
    const pool = site ? site.vendors : vendors;
    return q ? pool.filter((v) => `${v.name} ${v.id} ${v.address}`.toLowerCase().includes(q)) : pool;
  }, [site, vendors, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="relative min-h-[40vh] flex-1 bg-muted">
        <MapCanvas maps={maps} sites={sites} focus={site} onSelect={setSelected} />
      </div>
      <aside className="flex max-h-[50vh] w-full shrink-0 flex-col border-t border-line bg-surface md:max-h-none md:w-80 md:border-l md:border-t-0">
        <div className="border-b border-line p-3">
          {site && (
            <div className="mb-2 flex items-center gap-2 text-[12px] text-ink">
              <span className="font-medium">
                {site.vendors.length} vendor{site.vendors.length > 1 && 's'} at this location
              </span>
              <button type="button" onClick={() => setSelected(null)} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-2 hover:bg-muted hover:text-ink">
                <X size={13} aria-hidden /> Show all
              </button>
            </div>
          )}
          <label className="relative block">
            <span className="sr-only">Search vendors</span>
            <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, number or city"
              className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-2 text-[13px] text-ink placeholder:text-ink-3"
            />
          </label>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {listed.slice(0, LIST_LIMIT).map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => setSelected(siteKeyOf(v))} className="block w-full border-b border-line px-3 py-2 text-left hover:bg-muted">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{v.name}</span>
                  {v.isCustomer && <Badge tone="info">Also customer</Badge>}
                </span>
                <span className="block truncate text-[12px] text-ink-2">
                  {v.id} · {v.address}
                </span>
                <span className="text-[11px] text-ink-3">Placed by {PRECISION[v.precision]}</span>
              </button>
            </li>
          ))}
          {!listed.length && <li className="px-3 py-6 text-center text-[13px] text-ink-2">No vendors match.</li>}
          {listed.length > LIST_LIMIT && (
            <li className="px-3 py-3 text-center text-[12px] text-ink-3">
              Showing {LIST_LIMIT} of {listed.length}. Search to narrow the list.
            </li>
          )}
        </ul>
      </aside>
    </div>
  );
}

/** The vendor map as a page of its own. */
export function VendorMap() {
  const { data, error } = useVendorLocations();

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="max-w-md text-sm text-ink">{error}</p>
        <a href="/" className="text-sm text-brand hover:underline">
          Back to the workspace
        </a>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner className="h-6 w-6 text-brand" />
        <p className="text-sm text-ink-2">Reading vendors from SAP and looking up their addresses…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <a href="/" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-muted hover:text-ink">
          <ArrowLeft size={15} aria-hidden /> Workspace
        </a>
        <ProwessMark size={24} />
        <h1 className="text-[14px] font-semibold text-ink">Vendor map</h1>
        <p className="ml-auto text-right text-[12px] text-ink-2">
          {data.vendors.length} of {data.total} vendors on the map · {data.excluded} without a usable address · {data.system}
          {data.mock && ' (mock)'}
        </p>
      </header>
      <VendorExplorer maps={data.maps} vendors={data.vendors} />
    </div>
  );
}

/**
 * The vendor map inside a chat answer. Starts minimized as a small map in the
 * message; maximizing opens the map with the vendor list over the whole window.
 */
export function VendorMapCard({ data: card }: { data: { title: string; vendors: number; country?: string | undefined; city?: string | undefined } }) {
  const { data, error } = useVendorLocations();
  const [maximized, setMaximized] = useState(false);
  const [active, activate] = useIsActiveCard();
  const dialog = useRef<HTMLDialogElement>(null);

  const vendors = useMemo(() => {
    const city = card.city?.toLowerCase();
    return (data?.vendors ?? []).filter((v) => (!card.country || v.country === card.country) && (!city || v.address.toLowerCase().includes(city)));
  }, [data, card.country, card.city]);
  const sites = useMemo(() => groupSites(vendors), [vendors]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (maximized && !d.open) d.showModal();
    if (!maximized && d.open) d.close();
  }, [maximized]);

  return (
    <section aria-label={card.title} className="overflow-hidden rounded-area border border-area-sap/60 bg-surface shadow-soft">
      <header className="flex items-center gap-3 border-b border-area-sap/25 bg-area-sap-fill px-4 py-3">
        <MapPin size={18} aria-hidden className="shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Vendor map</p>
          <p className="truncate text-[14px] font-semibold text-ink">{card.title}</p>
        </div>
        {!active && (
          <button type="button" onClick={activate} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink hover:bg-muted">
            <MapPin size={13} aria-hidden /> Show map
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
          <Maximize2 size={13} aria-hidden /> Maximize
        </button>
      </header>

      <div className={cx('relative h-64 bg-muted', !active && 'hidden')}>
        {error ? (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-2">{error}</p>
        ) : !data ? (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-ink-2">
            <Spinner className="h-4 w-4 text-brand" /> Looking up vendor addresses…
          </p>
        ) : !vendors.length ? (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-2">None of these vendors has an address that can be placed on the map.</p>
        ) : (
          // The small map is hidden while the large one is open, so only one of them is live.
          active && !maximized && <MapCanvas maps={data.maps} sites={sites} onSelect={() => setMaximized(true)} />
        )}
      </div>

      {data && (
        <p className="border-t border-line px-4 py-2 text-[12px] text-ink-2">
          {vendors.length} of {card.vendors} vendors placed at {sites.length} location{sites.length !== 1 && 's'}
          {card.vendors > vendors.length && ` · ${card.vendors - vendors.length} without a usable address`}
        </p>
      )}

      <dialog
        ref={dialog}
        aria-label={card.title}
        onClose={() => setMaximized(false)}
        className={cx('m-auto h-[calc(100dvh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none overflow-hidden rounded-area border border-line bg-surface p-0 text-ink shadow-lift backdrop:bg-black/40', maximized && 'flex flex-col')}
      >
        {maximized && data && (
          <>
            <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
              <MapPin size={16} aria-hidden className="text-brand" />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{card.title}</h2>
              <span className="hidden text-[12px] text-ink-2 sm:inline">
                {vendors.length} vendors · {data.system}
                {data.mock && ' (mock)'}
              </span>
              <button type="button" onClick={() => setMaximized(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink hover:bg-muted">
                <Minimize2 size={13} aria-hidden /> Minimize
              </button>
            </div>
            <VendorExplorer maps={data.maps} vendors={vendors} />
          </>
        )}
      </dialog>
    </section>
  );
}
