import type { VendorLocation, VendorMap } from '@prowess/contracts';
import { currentContext, newCorrelationId, type Logger } from '@prowess/observability';
import type { AuditTrail } from '../audit/audit.js';
import type { AuthContext } from '../auth/types.js';
import type { OrchestratorConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import type { McpGateway } from '../mcp/gateway.js';
import { GeocodingError, type CachingGeocoder, type GeocodeQuery } from './geocoder.js';

const ADDRESS_TOOL = 'ap_listVendorAddresses';
/** Parallel lookups against the geocoding service. */
const GEOCODE_CONCURRENCY = 8;
/** SAP is read again for a user after this time; the vendor master changes rarely. */
const VENDOR_TTL_MS = 5 * 60_000;

interface VendorAddress {
  id: string;
  name: string;
  isCustomer: boolean;
  street?: string;
  houseNumber?: string;
  city?: string;
  postalCode?: string;
  region?: string;
  country: string;
}

/**
 * What to ask the geocoder for a vendor, or null when SAP holds nothing to
 * search for. Postal codes in the vendor master are unreliable, so the city
 * is used when there is one and the postal code only when there is not. The
 * region is left out: SAP mixes ISO codes with its own numeric ones.
 */
export function geocodeQueryFor(v: VendorAddress): GeocodeQuery | null {
  const street = [v.street, v.houseNumber].filter(Boolean).join(' ');
  if (v.city) return { address: [street, v.city].filter(Boolean).join(', '), country: v.country, hasCity: true };
  if (v.postalCode) return { address: [street, v.postalCode].filter(Boolean).join(', '), country: v.country, hasCity: false };
  return null;
}

const displayAddress = (v: VendorAddress) =>
  [[v.street, v.houseNumber].filter(Boolean).join(' '), [v.postalCode, v.city].filter(Boolean).join(' '), v.country].filter(Boolean).join(', ');

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Vendors of the connected SAP system with map coordinates. SAP is read as
 * the calling user, so SAP authorizations decide which vendors appear.
 */
export class VendorMapService {
  private readonly vendorCache = new Map<string, { at: number; vendors: VendorAddress[]; system: string; mock: boolean }>();

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

  async locations(auth: AuthContext): Promise<VendorMap> {
    const { geocoder, config, logger } = this.deps;
    if (!geocoder) throw new AppError('MAP_NOT_CONFIGURED', 'The vendor map is not set up yet: the geocoding key is missing.', 'CONFIGURATION');

    const { vendors, system, mock } = await this.vendors(auth);
    let failures = 0;
    const placed = await mapConcurrent(vendors, GEOCODE_CONCURRENCY, async (v): Promise<VendorLocation | null> => {
      const query = geocodeQueryFor(v);
      if (!query) return null;
      try {
        const hit = await geocoder.geocode(query);
        return hit && { id: v.id, name: v.name, isCustomer: v.isCustomer, address: displayAddress(v), country: v.country, ...hit };
      } catch (err) {
        if (!(err instanceof GeocodingError) && (err as Error).name !== 'TimeoutError') throw err;
        if (!failures++) logger.warn('geocode.failed', { error: (err as Error).message });
        return null;
      }
    });
    geocoder.flush();

    const located = placed.filter((p): p is VendorLocation => p !== null);
    // Nothing placed and every lookup refused: the key or its restrictions are wrong, not the addresses.
    if (!located.length && failures) throw new AppError('GEOCODING_FAILED', 'The addresses could not be looked up. Check the geocoding key and its restrictions.', 'CONFIGURATION', true);

    const { browserKey, mapId } = config.maps;
    return {
      vendors: located,
      total: vendors.length,
      excluded: vendors.length - located.length,
      system,
      mock,
      ...(browserKey && mapId && { maps: { apiKey: browserKey, mapId } }),
    };
  }

  private async vendors(auth: AuthContext) {
    const { mcp, audit, config } = this.deps;
    const key = `${auth.user.tenantId}|${auth.user.id}`;
    const cached = this.vendorCache.get(key);
    if (cached && Date.now() - cached.at < VENDOR_TTL_MS) return cached;

    const tool = (await mcp.listTools(config.environment)).find((t) => t.name === ADDRESS_TOOL);
    if (!tool) throw new AppError('TOOL_UNAVAILABLE', 'The SAP tool service is not reachable.', 'TOOL', true);
    const correlationId = currentContext()?.correlationId ?? newCorrelationId();
    const session = mcp.session({ user: auth.user, agent: 'vendor-map', environment: config.environment, correlationId, ...(auth.token && { userToken: auth.token }) });
    try {
      const out = await session.callTool(tool, {});
      const denied = out.errorCode === 'SAP_NOT_AUTHORIZED';
      audit.record({
        type: 'SAP_READ',
        userId: auth.user.id,
        tenantId: auth.user.tenantId,
        agent: 'vendor-map',
        tool: tool.name,
        targetSystem: tool.targetSystem,
        operation: 'SAP_READ',
        status: out.ok ? 'success' : denied ? 'denied' : 'failure',
        durationMs: out.durationMs,
        details: { objectType: 'Supplier', objectId: 'all' },
      });
      if (!out.ok) {
        if (denied) throw new AppError('SAP_NOT_AUTHORIZED', out.errorMessage ?? 'SAP denied access to the suppliers.', 'AUTHORIZATION');
        throw new AppError(out.errorCode ?? 'TOOL_ERROR', out.errorMessage ?? 'The suppliers could not be read from SAP.', 'SAP', out.retryable ?? false);
      }
      const structured = (out.structured ?? {}) as { data?: { vendors?: VendorAddress[] }; source?: { system: string; mock: boolean } };
      const entry = { at: Date.now(), vendors: structured.data?.vendors ?? [], system: structured.source?.system ?? tool.targetSystem, mock: structured.source?.mock ?? false };
      this.vendorCache.set(key, entry);
      return entry;
    } finally {
      await session.close();
    }
  }
}
