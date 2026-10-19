import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeQueryFor } from '../src/employees/employee-map-service.js';
import type { GeocodeQuery, Geocoder } from '../src/vendors/geocoder.js';
import { ofType, startStack, USERS } from './harness.js';

/** Knows Riyadh and Jeddah; anything else is not found. */
class FakeGeocoder implements Geocoder {
  readonly asked: GeocodeQuery[] = [];
  async geocode(query: GeocodeQuery) {
    this.asked.push(query);
    if (query.address === 'Riyadh') return { lat: 24.7136, lng: 46.6753, precision: 'city' as const };
    if (query.address === 'Jeddah') return { lat: 21.4858, lng: 39.1925, precision: 'city' as const };
    return null;
  }
}

describe('employee map API', () => {
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

  it('places employees at their work location, looking each location up once', async () => {
    const res = await stack.request('GET', '/api/v1/employees/locations', USERS.alex);
    expect(res.status).toBe(200);
    const map = res.json as unknown as { employees: { id: string; name: string; address: string; location: string; lat: number }[]; total: number; excluded: number; system: string; mock: boolean; maps: unknown };

    expect(map).toMatchObject({ total: 9, excluded: 0, system: 'SF-MOCK', mock: true, maps: { apiKey: 'browser-key', mapId: 'map-id' } });
    expect(map.employees.find((e) => e.id === '100102')).toMatchObject({ name: 'Jordan Lee', address: 'Accounts Payable Accountant · Jeddah', location: 'Jeddah', lat: 21.4858 });
    expect(map.employees.filter((e) => e.location === 'Riyadh')).toHaveLength(7);
    // Nine employees, two places: two lookups.
    expect(geocoder.asked).toEqual([
      { address: 'Riyadh', country: 'SA', hasCity: true },
      { address: 'Jeddah', country: 'SA', hasCity: true },
    ]);
    // No e-mail address or other personal field reaches the page, and the geocoding key never does.
    expect(res.text).not.toMatch(/@|server-key/);

    expect(stack.auditBuffer.events.find((e) => e.type === 'SAP_READ' && e.tool === 'sf_listEmployeeLocations')).toMatchObject({ userId: USERS.alex, agent: 'employee-map', status: 'success' });
  });

  it('is open only to users of the HCM agent', async () => {
    expect((await stack.request('GET', '/api/v1/employees/locations', USERS.jordan)).status).toBe(403);
    expect((await stack.request('GET', '/api/v1/employees/locations', USERS.casey)).status).toBe(403);
  });

  it('reports a configuration error when no geocoding key is set', async () => {
    const res = await bare.request('GET', '/api/v1/employees/locations', USERS.alex);
    expect(res.status).toBe(503);
    expect(res.json.error?.code).toBe('MAP_NOT_CONFIGURED');
  });

  it('answers a chat request for the map with a map component that carries no employee', async () => {
    const { status, events } = await stack.chat(USERS.alex, { message: 'Show the employees on a map.', agent: 'hcm' });
    expect(status).toBe(200);
    expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('sf_showEmployeeMap');
    const card = ofType(events, 'component').find((c) => c.component.type === 'employee_map');
    expect(card?.component.data).toEqual({ title: 'All employees', employees: 9 });

    const tools = await stack.services.mcp.listTools('DEV');
    expect(tools.find((t) => t.name === 'sf_listEmployeeLocations')?.internal).toBe(true);
  });
});

describe('work location query', () => {
  it('uses the city, or the location name without its code', () => {
    expect(placeQueryFor({ city: 'Jeddah', location: 'Jeddah Office (2000)', country: 'SA' })).toEqual({ address: 'Jeddah', country: 'SA', hasCity: true });
    expect(placeQueryFor({ location: 'Riyadh (1000)', country: 'sa' })).toEqual({ address: 'Riyadh', country: 'SA', hasCity: true });
  });

  it('searches with a country name, and filters by country only when it is an ISO code', () => {
    expect(placeQueryFor({ location: 'Riyadh (1000)', country: 'Saudi Arabia' })).toEqual({ address: 'Riyadh, Saudi Arabia', country: '', hasCity: true });
    expect(placeQueryFor({ location: 'Riyadh' })).toEqual({ address: 'Riyadh', country: '', hasCity: true });
  });

  it('gives up when SuccessFactors names no work location', () => {
    expect(placeQueryFor({ country: 'SA' })).toBeNull();
    expect(placeQueryFor({ location: '(1000)' })).toBeNull();
  });
});
