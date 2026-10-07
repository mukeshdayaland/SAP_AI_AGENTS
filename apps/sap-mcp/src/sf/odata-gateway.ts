import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { M, type Logger } from '@prowess/observability';
import { SapError, type SapCallContext } from '../sap/model.js';
import { encodeParameterValues, statusOf } from '../sap/odata-gateway.js';
import type { Employee, EntityQueryResult, JobHistoryEntry, SfGateway, UserMapping } from './model.js';
import { buildQueryParams, entityKeyPath, entityPath, type EntityQuery, type QueryFilter } from './query-builder.js';

/**
 * SuccessFactors gateway over the HCM OData V2 API, reached through a BTP
 * destination whose URL ends in `/odata/v2`.
 *
 * Identity: the destination uses `OAuth2SAMLBearerAssertion`. The SAP Cloud
 * SDK exchanges the user's JWT for a SuccessFactors token (and caches it), so
 * every call runs as the end user and SuccessFactors role-based permissions
 * decide what comes back. There is no technical-user mode: without a user
 * token the call is refused.
 *
 * Entity and field names follow the standard data model and must be checked
 * against the tenant's `$metadata`.
 */

export interface SfODataGatewayConfig {
  destinationName: string;
  systemId: string;
  userMapping: UserMapping;
  logger: Logger;
}

type ODataEntity = Record<string, unknown>;

const EMPLOYEE_SELECT = ['userId', 'displayName', 'firstName', 'lastName', 'email', 'title', 'department', 'division', 'location', 'status', 'hireDate', 'manager/userId', 'manager/displayName'];
const JOB_SELECT = ['userId', 'startDate', 'endDate', 'jobTitle', 'department', 'division', 'location', 'company', 'managerId', 'event', 'eventReason'];
const TEAM_PAGE = 200;
const SEARCH_PAGE = 25;
const IDENTITY_TTL_MS = 10 * 60_000;
const IDENTITY_CACHE_SIZE = 5_000;

const str = (v: unknown) => String(v ?? '').trim();
const opt = (v: unknown) => str(v) || undefined;
const results = (v: unknown) => ((v as { results?: ODataEntity[] } | undefined)?.results ?? []) as ODataEntity[];

/** `/Date(1695000000000)/` or `/Date(1695000000000+0000)/` → `2023-09-18` */
function odataDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = /\/Date\((-?\d+)/.exec(v)?.[1];
  if (ms) return new Date(Number(ms)).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
}

/** An end date of 9999-12-31 means the record is still valid. */
const endDate = (v: unknown) => {
  const date = odataDate(v);
  return date?.startsWith('9999') ? undefined : date;
};

/** Claims of the forwarded user token. Its hash is bound to the signed principal, so it is not verified again here. */
function tokenClaims(jwt: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt?.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Why a request failed, down the cause chain. A failed token exchange surfaces as "Failed to build headers";
 * the reason SuccessFactors or the destination service gave is only in the causes. Tokens are masked.
 */
function causesOf(err: unknown): string[] {
  const causes: string[] = [];
  let e = (err as { cause?: unknown } | undefined)?.cause;
  for (let i = 0; i < 6 && e; i++) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === 'string' && message) {
      causes.push(message.replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '<token>').replace(/Bearer\s+\S+/gi, 'Bearer <token>').slice(0, 500));
    }
    e = (e as { cause?: unknown }).cause;
  }
  return causes;
}

function toEmployee(e: ODataEntity): Employee {
  const manager = e.manager as ODataEntity | null | undefined;
  const name = str(e.displayName) || `${str(e.firstName)} ${str(e.lastName)}`.trim() || str(e.userId);
  const status = str(e.status).toLowerCase();
  return {
    userId: str(e.userId),
    displayName: name,
    ...(opt(e.email) && { email: opt(e.email) }),
    ...(opt(e.title) && { jobTitle: opt(e.title) }),
    ...(opt(e.department) && { department: opt(e.department) }),
    ...(opt(e.division) && { division: opt(e.division) }),
    ...(opt(e.location) && { location: opt(e.location) }),
    ...(opt(manager?.userId) && { managerId: opt(manager?.userId) }),
    ...(opt(manager?.displayName) && { managerName: opt(manager?.displayName) }),
    ...(odataDate(e.hireDate) && { hireDate: odataDate(e.hireDate) }),
    status: status === 't' || status === 'active' ? 'ACTIVE' : 'INACTIVE',
  };
}

export class SfODataGateway implements SfGateway {
  readonly mock = false;
  private readonly identities = new Map<string, { userId: string; expires: number }>();

  constructor(private readonly cfg: SfODataGatewayConfig) {}

  get systemId() {
    return this.cfg.systemId;
  }

  private async get(ctx: SapCallContext, what: string, url: string, params: Record<string, string>): Promise<unknown> {
    if (!ctx.userJwt) throw new SapError('NOT_AUTHORIZED', 'No end-user identity is available for SuccessFactors; the request was refused.');
    const started = Date.now();
    try {
      const res = await executeHttpRequest(
        { destinationName: this.cfg.destinationName, jwt: ctx.userJwt },
        { method: 'get', url, params, parameterEncoder: encodeParameterValues, headers: { accept: 'application/json', 'x-correlation-id': ctx.correlationId }, timeout: 20_000 },
        { fetchCsrfToken: false },
      );
      return (res.data as { d?: unknown }).d ?? res.data;
    } catch (err) {
      const status = statusOf(err);
      this.cfg.logger.warn('sf.request_failed', { what, status, error: (err as Error).message, ...(causesOf(err).length && { causes: causesOf(err) }) });
      if (status === 404) throw new SapError('NOT_FOUND', `${what} was not found in SuccessFactors.`);
      if (status === 401 || status === 403) throw new SapError('NOT_AUTHORIZED', `SuccessFactors denied access to ${what}.`);
      if (status === 400) throw new SapError('INVALID_INPUT', `SuccessFactors rejected the request for ${what}.`);
      if (status === 429) throw new SapError('UNAVAILABLE', 'SuccessFactors is limiting requests right now. Try again in a moment.', true);
      throw new SapError('UNAVAILABLE', `SuccessFactors is not reachable right now (${what}).`, true);
    } finally {
      M.sapDuration().observe({ system: this.systemId, method: 'get' }, Date.now() - started);
    }
  }

  private async employees(ctx: SapCallContext, what: string, filter: QueryFilter, top: number): Promise<Employee[]> {
    const d = await this.get(ctx, what, entityPath('User'), buildQueryParams({ entityName: 'User', select: EMPLOYEE_SELECT, expand: ['manager'], filter, orderBy: [{ field: 'displayName', direction: 'asc' }], top }));
    return results(d).map(toEmployee);
  }

  async whoAmI(ctx: SapCallContext): Promise<string> {
    const claims = tokenClaims(ctx.userJwt);
    const login = this.cfg.userMapping === 'email' ? str(claims.email) || ctx.principal.sub : str(claims.user_name) || ctx.principal.sub;
    if (!login) throw new SapError('NOT_AUTHORIZED', 'Your login carries no identity that could be matched to a SuccessFactors user.');
    if (this.cfg.userMapping === 'userId') return login;

    const key = `${ctx.principal.tenant}:${login.toLowerCase()}`;
    const cached = this.identities.get(key);
    if (cached && cached.expires > Date.now()) return cached.userId;

    const d = await this.get(
      ctx,
      'Your SuccessFactors user',
      entityPath('User'),
      buildQueryParams({ entityName: 'User', select: ['userId'], filter: { field: this.cfg.userMapping, operator: 'eq', value: login }, top: 2 }),
    );
    const matches = results(d);
    if (!matches.length) throw new SapError('NOT_FOUND', 'No SuccessFactors user is linked to your login.');
    if (matches.length > 1) throw new SapError('BUSINESS_RULE', 'More than one SuccessFactors user matches your login, so none was chosen.');
    const userId = str(matches[0]!.userId);
    if (this.identities.size >= IDENTITY_CACHE_SIZE) this.identities.clear();
    this.identities.set(key, { userId, expires: Date.now() + IDENTITY_TTL_MS });
    return userId;
  }

  async getEmployee(ctx: SapCallContext, userId: string): Promise<Employee> {
    const what = `Employee ${userId}`;
    const d = await this.get(ctx, what, entityKeyPath('User', userId), { $format: 'json', $select: EMPLOYEE_SELECT.join(','), $expand: 'manager' });
    if (!str((d as ODataEntity).userId)) throw new SapError('NOT_FOUND', `${what} was not found in SuccessFactors.`);
    return toEmployee(d as ODataEntity);
  }

  listDirectReports(ctx: SapCallContext, managerId: string): Promise<Employee[]> {
    return this.employees(ctx, `Direct reports of ${managerId}`, { field: 'manager/userId', operator: 'eq', value: managerId }, TEAM_PAGE);
  }

  searchEmployees(ctx: SapCallContext, query: string): Promise<Employee[]> {
    const contains = (field: string): QueryFilter => ({ field, operator: 'contains', value: query });
    return this.employees(ctx, `Employees matching "${query}"`, { or: ['displayName', 'firstName', 'lastName', 'username'].map(contains) }, SEARCH_PAGE);
  }

  async getJobHistory(ctx: SapCallContext, userId: string): Promise<JobHistoryEntry[]> {
    const d = await this.get(
      ctx,
      `Job history of ${userId}`,
      entityPath('EmpJob'),
      buildQueryParams({
        entityName: 'EmpJob',
        select: JOB_SELECT,
        filter: { field: 'userId', operator: 'eq', value: userId },
        orderBy: [{ field: 'startDate', direction: 'desc' }],
        top: 100,
        fromDate: '1900-01-01',
        toDate: '9999-12-31',
      }),
    );
    return results(d).map((e) => ({
      startDate: odataDate(e.startDate) ?? '',
      ...(endDate(e.endDate) && { endDate: endDate(e.endDate) }),
      ...(opt(e.jobTitle) && { jobTitle: opt(e.jobTitle) }),
      ...(opt(e.department) && { department: opt(e.department) }),
      ...(opt(e.division) && { division: opt(e.division) }),
      ...(opt(e.location) && { location: opt(e.location) }),
      ...(opt(e.company) && { company: opt(e.company) }),
      ...(opt(e.managerId) && { managerId: opt(e.managerId) }),
      ...(opt(e.event) && { event: opt(e.event) }),
      ...(opt(e.eventReason) && { eventReason: opt(e.eventReason) }),
    }));
  }

  async queryEntity(ctx: SapCallContext, query: EntityQuery): Promise<EntityQueryResult> {
    const d = (await this.get(ctx, `${query.entityName} records`, entityPath(query.entityName), buildQueryParams(query))) as { results?: ODataEntity[]; __next?: unknown };
    // Only the selected fields are passed on; `__metadata` and deferred navigations are dropped.
    const value = (v: unknown) => (typeof v === 'string' && v.startsWith('/Date(') ? (odataDate(v) ?? v) : typeof v === 'object' ? null : (v ?? null));
    const records = results(d).map((e) => Object.fromEntries(query.select.map((field) => [field, value(e[field])])));
    return { records, hasMore: Boolean(d.__next) };
  }
}
