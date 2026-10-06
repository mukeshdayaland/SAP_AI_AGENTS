import { createLogger } from '@prowess/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CachingGeocoder, GeocodingError, GoogleGeocoder, type GeocodeQuery, type Geocoder } from '../src/vendors/geocoder.js';
import { geocodeQueryFor } from '../src/vendors/vendor-map-service.js';
import { ofType, startStack, USERS } from './harness.js';

const silent = createLogger({ service: 'test', level: 'error', sink: () => {} });

/** Places every address in Riyadh at street level, except Dubai, which it does not know. */
class FakeGeocoder implements Geocoder {
  readonly asked: GeocodeQuery[] = [];
  async geocode(query: GeocodeQuery) {
    this.asked.push(query);
    return query.address.includes('Dubai') ? null : { lat: 24.7136, lng: 46.6753, precision: 'street' as const };
  }
}

describe('vendor map API', () => {
  const geocoder = new FakeGeocoder();
  let stack: Awaited<ReturnType<typeof startStack>>;
  let bare: Awaited<ReturnType<typeof startStack>>;

  beforeAll(async () => {
    stack = await startStack({ geocoder, env: { MAPS_API: 'browser-key', MAPS_MAP_ID: 'map-id', GEO_API: 'server-key' } });
    bare = await startStack();
  });
  afterAll(async () => {
    await stack.stop();
    await bare.stop();
  });

  it('places the vendors SAP returns and leaves out those without a usable address', async () => {
    const res = await stack.request('GET', '/api/v1/vendors/locations', USERS.jordan);
    expect(res.status).toBe(200);
    const map = res.json as unknown as { vendors: { id: string; address: string; precision: string }[]; total: number; excluded: number; system: string; mock: boolean; maps: unknown };

    expect(map.system).toBe('S4-MOCK');
    expect(map.mock).toBe(true);
    expect(map.total).toBe(map.vendors.length + map.excluded);
    expect(map.vendors.find((v) => v.id === '1000123')).toMatchObject({ address: 'King Fahd Road 7, 12271 Riyadh, SA', lat: 24.7136, lng: 46.6753, precision: 'street' });
    // No address in SAP, and an address the geocoder cannot resolve.
    expect(map.vendors.map((v) => v.id)).not.toContain('VENDTEST');
    expect(map.vendors.map((v) => v.id)).not.toContain('1000456');
    expect(geocoder.asked.every((q) => q.address !== '')).toBe(true);
    // The browser key and map ID go to the page; the geocoding key never does.
    expect(map.maps).toEqual({ apiKey: 'browser-key', mapId: 'map-id' });
    expect(res.text).not.toContain('server-key');

    expect(stack.auditBuffer.events.find((e) => e.type === 'SAP_READ' && e.tool === 'ap_listVendorAddresses')).toMatchObject({ userId: USERS.jordan, status: 'success' });
  });

  it('looks an address up once, however often the map is opened', async () => {
    const before = geocoder.asked.length;
    await stack.request('GET', '/api/v1/vendors/locations', USERS.jordan);
    await stack.request('GET', '/api/v1/vendors/locations', USERS.alex);
    // Dubai was not found, and an unresolved address is not asked again within a day either.
    expect(geocoder.asked.length).toBe(before);
  });

  it('limits requests per address as well as per user', async () => {
    const limited = await startStack({ geocoder, env: { GEO_API: 'server-key', RATE_LIMIT_PER_MINUTE: '1' } });
    try {
      // One request a minute per user allows ten a minute per address. Two users use those up between them.
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await limited.request('GET', '/api/v1/help', i % 2 ? USERS.alex : USERS.jordan)).status);
      expect(statuses.slice(0, 2)).toEqual([200, 200]);
      // A third user has made no request yet, so only the per-address limit can refuse this one.
      const last = await limited.request('GET', '/api/v1/help', USERS.sam);
      expect(last.status).toBe(429);
      expect(last.json.error?.code).toBe('RATE_LIMITED');
    } finally {
      await limited.stop();
    }
  });

  it('reports a configuration error when no geocoding key is set', async () => {
    const res = await bare.request('GET', '/api/v1/vendors/locations');
    expect(res.status).toBe(503);
    expect(res.json.error?.code).toBe('MAP_NOT_CONFIGURED');
  });

  it('answers a chat request for the map with a map component', async () => {
    const { status, events } = await stack.chat(USERS.jordan, { message: 'Show the vendors on a map.', agent: 'fico' });
    expect(status).toBe(200);
    expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('ap_showVendorMap');
    const card = ofType(events, 'component').find((c) => c.component.type === 'vendor_map');
    // The component carries the filter only; the page loads the vendors itself.
    expect(card?.component.data).toMatchObject({ title: 'All vendors' });
    expect(JSON.stringify(card)).not.toMatch(/King Fahd|lat/);
  });

  it('keeps the vendor address tool away from models', async () => {
    const tools = await stack.services.mcp.listTools('DEV');
    expect(tools.find((t) => t.name === 'ap_listVendorAddresses')?.internal).toBe(true);
  });
});

describe('geocoding query', () => {
  const base = { id: '1', name: 'V', isCustomer: false, country: 'IN' };

  it('searches by city and ignores the postal code and region when a city is known', () => {
    expect(geocodeQueryFor({ ...base, street: 'LBS NAGAR', houseNumber: '4', city: 'BANGALORE', postalCode: '123456', region: '10' })).toEqual({
      address: 'LBS NAGAR 4, BANGALORE',
      country: 'IN',
      hasCity: true,
    });
  });

  it('falls back to the postal code, and gives up when there is neither', () => {
    expect(geocodeQueryFor({ ...base, postalCode: '560066' })).toEqual({ address: '560066', country: 'IN', hasCity: false });
    expect(geocodeQueryFor({ ...base, street: 'Main Road', region: 'KA' })).toBeNull();
  });
});

describe('Google geocoder', () => {
  const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  const result = (types: string[], location_type = 'APPROXIMATE') => ({ status: 'OK', results: [{ types, geometry: { location: { lat: 12.97, lng: 77.59 }, location_type } }] });
  const query = { address: 'LBS Nagar, Bangalore', country: 'IN', hasCity: true };

  it('sends the address with the country as a filter', async () => {
    let asked: URL | undefined;
    const fetchImpl = (async (url: URL) => {
      asked = url;
      return new Response(JSON.stringify(result(['locality'])));
    }) as unknown as typeof fetch;
    await new GoogleGeocoder('server-key', fetchImpl).geocode(query);
    expect(asked?.origin).toBe('https://maps.googleapis.com');
    expect(asked?.searchParams.get('components')).toBe('country:IN');
    expect(asked?.searchParams.get('address')).toBe('LBS Nagar, Bangalore');
  });

  it('grades a hit by how exactly Google placed it', async () => {
    expect((await new GoogleGeocoder('k', reply(result(['street_address'], 'ROOFTOP'))).geocode(query))?.precision).toBe('street');
    expect((await new GoogleGeocoder('k', reply(result(['locality', 'political']))).geocode(query))?.precision).toBe('city');
    expect((await new GoogleGeocoder('k', reply(result(['administrative_area_level_1']))).geocode(query))?.precision).toBe('approximate');
    // A postal-code search that lands on a town is still only a postal-code placement.
    expect((await new GoogleGeocoder('k', reply(result(['locality']))).geocode({ ...query, hasCity: false }))?.precision).toBe('approximate');
  });

  it('treats a country-only answer and no answer as not found', async () => {
    expect(await new GoogleGeocoder('k', reply(result(['country', 'political']))).geocode(query)).toBeNull();
    expect(await new GoogleGeocoder('k', reply({ status: 'ZERO_RESULTS', results: [] })).geocode(query)).toBeNull();
  });

  it('raises an error when Google refuses the request', async () => {
    await expect(new GoogleGeocoder('k', reply({ status: 'REQUEST_DENIED' })).geocode(query)).rejects.toBeInstanceOf(GeocodingError);
  });
});

describe('geocode cache', () => {
  it('keeps hits for 30 days and retries unresolved addresses after a day', async () => {
    const inner = new FakeGeocoder();
    let now = 0;
    const cache = new CachingGeocoder(inner, silent, undefined, () => now);
    const riyadh = { address: 'King Fahd Road, Riyadh', country: 'SA', hasCity: true };
    const dubai = { address: 'Dubai', country: 'AE', hasCity: true };

    await Promise.all([cache.geocode(riyadh), cache.geocode({ ...riyadh, address: 'king fahd road,  riyadh' }), cache.geocode(dubai)]);
    expect(inner.asked).toHaveLength(2);

    now = 2 * 86_400_000;
    await cache.geocode(riyadh);
    await cache.geocode(dubai);
    expect(inner.asked).toHaveLength(3);

    now = 31 * 86_400_000;
    await cache.geocode(riyadh);
    expect(inner.asked).toHaveLength(4);
  });
});
