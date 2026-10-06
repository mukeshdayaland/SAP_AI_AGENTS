import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LocationPrecision } from '@prowess/contracts';
import type { Logger } from '@prowess/observability';

export interface GeocodeQuery {
  /** Free-text address without the country. */
  address: string;
  /** ISO 3166-1 alpha-2 country code; restricts the search so a region code such as IN is not read as a country. */
  country: string;
  /** The address names a city, so a hit on the place is a city-level hit. */
  hasCity: boolean;
}

export interface GeocodeHit {
  lat: number;
  lng: number;
  precision: LocationPrecision;
}

export interface Geocoder {
  /** Null when the address cannot be resolved to anything more precise than a country. */
  geocode(query: GeocodeQuery): Promise<GeocodeHit | null>;
}

/** Raised when the geocoding service refuses or fails, as opposed to finding nothing. */
export class GeocodingError extends Error {}

const STREET_TYPES = new Set(['street_address', 'premise', 'subpremise', 'route', 'intersection', 'establishment', 'point_of_interest']);
const CITY_TYPES = new Set(['locality', 'sublocality', 'neighborhood', 'postal_town', 'administrative_area_level_3']);

interface GoogleResult {
  types: string[];
  geometry: { location: { lat: number; lng: number }; location_type: string };
}

/** Google Geocoding API. The key is a server key and never leaves the orchestrator. */
export class GoogleGeocoder implements Geocoder {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async geocode(query: GeocodeQuery): Promise<GeocodeHit | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query.address);
    if (query.country) url.searchParams.set('components', `country:${query.country}`);
    url.searchParams.set('key', this.apiKey);
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => ({}))) as { status?: string; results?: GoogleResult[] };
    if (body.status === 'ZERO_RESULTS') return null;
    if (body.status !== 'OK' || !body.results?.length) throw new GeocodingError(`Geocoding failed with status ${body.status ?? res.status}`);
    const r = body.results[0]!;
    // With a country filter Google answers an unknown address with the country itself; that is not a location.
    if (r.types.includes('country')) return null;
    const { lat, lng } = r.geometry.location;
    const exact = r.geometry.location_type === 'ROOFTOP' || r.geometry.location_type === 'RANGE_INTERPOLATED';
    const precision: LocationPrecision =
      exact || r.types.some((t) => STREET_TYPES.has(t)) ? 'street' : query.hasCity && r.types.some((t) => CITY_TYPES.has(t)) ? 'city' : 'approximate';
    return { lat, lng, precision };
  }
}

type CacheEntry = { at: number; hit: GeocodeHit | null };

/** Google's terms allow coordinates to be kept for 30 days; unresolved addresses are retried after a day. */
const HIT_TTL_MS = 30 * 86_400_000;
const MISS_TTL_MS = 86_400_000;

/**
 * Remembers geocoding results so an address is looked up once, not on every
 * map load. Kept in a JSON file when a path is given, otherwise in memory.
 */
export class CachingGeocoder implements Geocoder {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<GeocodeHit | null>>();
  private dirty = false;

  constructor(
    private readonly inner: Geocoder,
    private readonly logger: Logger,
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, CacheEntry>)) this.entries.set(k, v);
    } catch {
      /* no cache yet */
    }
  }

  geocode(query: GeocodeQuery): Promise<GeocodeHit | null> {
    const key = `${query.country}|${query.address}`.toLowerCase().replace(/\s+/g, ' ');
    const cached = this.entries.get(key);
    if (cached && this.now() - cached.at < (cached.hit ? HIT_TTL_MS : MISS_TTL_MS)) return Promise.resolve(cached.hit);
    let lookup = this.pending.get(key);
    if (!lookup) {
      lookup = this.inner
        .geocode(query)
        .then((hit) => {
          this.entries.set(key, { at: this.now(), hit });
          this.dirty = true;
          return hit;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, lookup);
    }
    return lookup;
  }

  /** Writes the cache to disk if it changed. A failure only costs repeat lookups. */
  flush(): void {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.entries)));
      this.dirty = false;
    } catch (err) {
      this.logger.warn('geocode.cache_write_failed', { error: (err as Error).message });
    }
  }
}
