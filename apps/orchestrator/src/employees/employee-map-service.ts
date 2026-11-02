import type { EmployeeLocation, EmployeeMap } from '@prowess/contracts';
import { currentContext, newCorrelationId, type Logger } from '@prowess/observability';
import type { AuditTrail } from '../audit/audit.js';
import { tokensOf, type AuthContext } from '../auth/types.js';
import type { OrchestratorConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import type { McpGateway } from '../mcp/gateway.js';
import { GeocodingError, type CachingGeocoder, type GeocodeHit, type GeocodeQuery } from '../vendors/geocoder.js';
import { mapConcurrent } from '../vendors/vendor-map-service.js';

const LOCATION_TOOL = 'sf_listEmployeeLocations';
const GEOCODE_CONCURRENCY = 8;
/** SuccessFactors is read again for a user after this time. */
const EMPLOYEE_TTL_MS = 5 * 60_000;

interface EmployeePlace {
  userId: string;
  displayName: string;
  jobTitle?: string;
  location?: string;
  city?: string;
  country?: string;
}

/**
 * What to ask the geocoder for an employee's work location, or null when
 * SuccessFactors names none. The city is used when there is one, otherwise the
 * location name without its code ("Riyadh (1000)" → "Riyadh"). The country is a
 * filter only when it is an ISO code; a country name becomes part of the search.
 */
export function placeQueryFor(e: Pick<EmployeePlace, 'location' | 'city' | 'country'>): GeocodeQuery | null {
  const place = (e.city ?? e.location)?.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!place) return null;
  const country = e.country?.trim() ?? '';
  const iso = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : '';
  return { address: iso || !country ? place : `${place}, ${country}`, country: iso, hasCity: true };
}

/**
 * Employees of the connected SuccessFactors system with the coordinates of
 * their work location. SuccessFactors is read as the calling user, so its
 * role-based permissions decide which employees appear. Home addresses are
 * never read: an employee is placed where they work.
 */
export class EmployeeMapService {
  private readonly cache = new Map<string, { at: number; employees: EmployeePlace[]; system: string; mock: boolean }>();

  constructor(
    private readonly deps: {
      mcp: McpGateway;
      audit: AuditTrail;
      logger: Logger;
      config: OrchestratorConfig;
      /** Absent when no geocoding key is configured. */
      geocoder?: CachingGeocoder;
    },
  ) {}

  async locations(auth: AuthContext): Promise<EmployeeMap> {
    const { geocoder, config, logger } = this.deps;
    if (!geocoder) throw new AppError('MAP_NOT_CONFIGURED', 'The employee map is not set up yet: the geocoding key is missing.', 'CONFIGURATION');

    const { employees, system, mock } = await this.employees(auth);
    // Many employees share a work location, so each distinct place is looked up once.
    const queries = new Map<string, GeocodeQuery>();
    for (const e of employees) {
      const query = placeQueryFor(e);
      if (query) queries.set(`${query.country}|${query.address.toLowerCase()}`, query);
    }
    let failures = 0;
    const hits = new Map<string, GeocodeHit | null>();
    await mapConcurrent([...queries], GEOCODE_CONCURRENCY, async ([key, query]) => {
      try {
        hits.set(key, await geocoder.geocode(query));
      } catch (err) {
        if (!(err instanceof GeocodingError) && (err as Error).name !== 'TimeoutError') throw err;
        if (!failures++) logger.warn('geocode.failed', { error: (err as Error).message });
        hits.set(key, null);
      }
    });
    geocoder.flush();

    const located = employees.flatMap((e): EmployeeLocation[] => {
      const query = placeQueryFor(e);
      const hit = query && hits.get(`${query.country}|${query.address.toLowerCase()}`);
      if (!hit) return [];
      const location = e.location ?? e.city ?? '';
      return [{ id: e.userId, name: e.displayName, address: [e.jobTitle, location].filter(Boolean).join(' · '), location, ...hit }];
    });
    if (!located.length && failures) throw new AppError('GEOCODING_FAILED', 'The work locations could not be looked up. Check the geocoding key and its restrictions.', 'CONFIGURATION', true);

    const { browserKey, mapId } = config.maps;
    return { employees: located, total: employees.length, excluded: employees.length - located.length, system, mock, ...(browserKey && mapId && { maps: { apiKey: browserKey, mapId } }) };
  }

  private async employees(auth: AuthContext) {
    const { mcp, audit, config } = this.deps;
    const key = `${auth.user.tenantId}|${auth.user.id}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < EMPLOYEE_TTL_MS) return cached;

    const tool = (await mcp.listTools(config.environment)).find((t) => t.name === LOCATION_TOOL);
    if (!tool) throw new AppError('TOOL_UNAVAILABLE', 'The SuccessFactors tool service is not reachable.', 'TOOL', true);
    const correlationId = currentContext()?.correlationId ?? newCorrelationId();
    const session = mcp.session({ user: auth.user, agent: 'employee-map', environment: config.environment, correlationId, ...tokensOf(auth) });
    try {
      const out = await session.callTool(tool, {});
      const denied = out.errorCode === 'SAP_NOT_AUTHORIZED';
      audit.record({
        type: 'SAP_READ',
        userId: auth.user.id,
        tenantId: auth.user.tenantId,
        agent: 'employee-map',
        tool: tool.name,
        targetSystem: tool.targetSystem,
        operation: 'SAP_READ',
        status: out.ok ? 'success' : denied ? 'denied' : 'failure',
        durationMs: out.durationMs,
        details: { objectType: 'Employee', objectId: 'all' },
      });
      if (!out.ok) {
        if (denied) throw new AppError('SAP_NOT_AUTHORIZED', out.errorMessage ?? 'SuccessFactors denied access to the employees.', 'AUTHORIZATION');
        throw new AppError(out.errorCode ?? 'TOOL_ERROR', out.errorMessage ?? 'The employees could not be read from SuccessFactors.', 'SAP', out.retryable ?? false);
      }
      const structured = (out.structured ?? {}) as { data?: { employees?: EmployeePlace[] }; source?: { system: string; mock: boolean } };
      const entry = { at: Date.now(), employees: structured.data?.employees ?? [], system: structured.source?.system ?? tool.targetSystem, mock: structured.source?.mock ?? false };
      this.cache.set(key, entry);
      return entry;
    } finally {
      await session.close();
    }
  }
}
