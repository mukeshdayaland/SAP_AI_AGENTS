import { randomUUID } from 'node:crypto';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { M, type Logger } from '@prowess/observability';
import { SapError, type SapCallContext } from '../sap/model.js';
import { encodeParameterValues, isTimeout, statusOf } from '../sap/odata-gateway.js';
import type { Absence, AbsenceStatus, ApprovalRequest, Employee, EmployeePlace, EntityField, EntityQueryResult, EntityRead, JobHistoryEntry, NewTimeOff, OpenPosition, SfGateway, TimeOffBalance, TimeType, UserMapping } from './model.js';
import { assertSafeFieldName, buildFilter, buildQueryParams, entityKeyPath, entityPath, formatLiteral, type EntityQuery, type QueryFilter } from './query-builder.js';

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
const PLACE_SELECT = ['userId', 'displayName', 'firstName', 'lastName', 'title', 'department', 'location', 'city', 'country'];
/** Employees are read in pages; the page limit caps one map load at 10,000 employees. */
const PLACE_PAGE_SIZE = 1000;
const PLACE_MAX_PAGES = 10;
const TEAM_PAGE = 200;
const SEARCH_PAGE = 25;
const IDENTITY_TTL_MS = 10 * 60_000;
const IDENTITY_CACHE_SIZE = 5_000;
/** Employees named in one absence query; a longer filter risks the URL length limit. */
const ABSENCE_USERS = 40;
/** Account types read per employee; each one is its own balance request. */
const BALANCE_ACCOUNT_TYPES = 8;
/** `VACATION_ACC` → `Vacation acc`. Account types are codes; the tenant's label for them is not read. */
const accountName = (code: string) => code.replaceAll(/[_-]+/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const str = (v: unknown) => String(v ?? '').trim();
const opt = (v: unknown) => str(v) || undefined;
/** The first of several property names that carries a value. */
const first = (e: ODataEntity, ...names: string[]) => names.map((n) => opt(e[n])).find(Boolean);
const absenceStatus = (v: unknown): AbsenceStatus => {
  const status = str(v).toUpperCase();
  return status.startsWith('PEND') ? 'PENDING' : status.startsWith('REJ') || status.startsWith('DECL') ? 'REJECTED' : status.startsWith('CANCEL') ? 'CANCELLED' : 'APPROVED';
};
/** The message SuccessFactors returned with an error, for the log. */
const sfMessageOf = (err: unknown) => {
  const message = (err as { response?: { data?: { error?: { message?: { value?: unknown } } } } }).response?.data?.error?.message?.value;
  return typeof message === 'string' ? message.replace(/\s+/g, ' ').slice(0, 300) : undefined;
};
const results = (v: unknown) => ((v as { results?: ODataEntity[] } | undefined)?.results ?? []) as ODataEntity[];

/** `/Date(1695000000000)/` or `/Date(1695000000000+0000)/` → `2023-09-18` */
function odataDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = /\/Date\((-?\d+)/.exec(v)?.[1];
  if (ms) return new Date(Number(ms)).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
}

/** `2026-11-02` → `/Date(1793577600000)/`, the OData V2 date of a request body. */
const toODataDate = (isoDate: string) => `/Date(${Date.parse(`${isoDate}T00:00:00Z`)})/`;

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
  private readonly shapesLogged = new Set<string>();

  constructor(private readonly cfg: SfODataGatewayConfig) {}

  get systemId() {
    return this.cfg.systemId;
  }

  private get(ctx: SapCallContext, what: string, url: string, params: Record<string, string>): Promise<unknown> {
    return this.send(ctx, what, 'get', url, params);
  }

  private async send(ctx: SapCallContext, what: string, method: 'get' | 'post', url: string, params: Record<string, string>, accept = 'application/json', body?: unknown): Promise<unknown> {
    if (!ctx.userJwt) throw new SapError('NOT_AUTHORIZED', 'No end-user identity is available for SuccessFactors; the request was refused.');
    const started = Date.now();
    try {
      const res = await executeHttpRequest(
        { destinationName: this.cfg.destinationName, jwt: ctx.userJwt },
        {
          method,
          url,
          params,
          parameterEncoder: encodeParameterValues,
          ...(body !== undefined && { data: body }),
          headers: { accept, 'x-correlation-id': ctx.correlationId, ...(body !== undefined && { 'content-type': 'application/json' }) },
          timeout: 20_000,
        },
        { fetchCsrfToken: false },
      );
      return (res.data as { d?: unknown }).d ?? res.data;
    } catch (err) {
      const status = statusOf(err);
      const sfMessage = sfMessageOf(err);
      this.cfg.logger.warn('sf.request_failed', { what, method, url, status, error: (err as Error).message, ...(sfMessage && { sfMessage }), ...(causesOf(err).length && { causes: causesOf(err) }) });
      if (status === 404) throw new SapError('NOT_FOUND', `${what} was not found in SuccessFactors.`);
      if (status === 401 || status === 403) throw new SapError('NOT_AUTHORIZED', `SuccessFactors denied access to ${what}.`);
      // A refused decision is a business outcome the user can act on, so SuccessFactors' reason is passed on.
      if (status === 400 && method === 'post') throw new SapError('BUSINESS_RULE', `SuccessFactors rejected ${what}${sfMessage ? `: ${sfMessage}` : '.'}`);
      // SuccessFactors names the property or value it did not accept, which is what the caller needs to correct the request.
      if (status === 400) throw new SapError('INVALID_INPUT', `SuccessFactors rejected the request for ${what}${sfMessage ? `: ${sfMessage}` : '.'}`);
      if (status === 429) throw new SapError('UNAVAILABLE', 'SuccessFactors is limiting requests right now. Try again in a moment.', true);
      if (method === 'post' && isTimeout(err)) throw new SapError('OUTCOME_UNKNOWN', `SuccessFactors did not answer in time for ${what}, so it is not known whether the change was made.`);
      throw new SapError('UNAVAILABLE', `SuccessFactors is not reachable right now (${what}).`, true);
    } finally {
      M.sapDuration().observe({ system: this.systemId, method }, Date.now() - started);
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

  async listEmployeePlaces(ctx: SapCallContext): Promise<EmployeePlace[]> {
    const places: EmployeePlace[] = [];
    // SuccessFactors returns active users unless a status is asked for.
    for (let page = 0; page < PLACE_MAX_PAGES; page++) {
      const d = await this.get(ctx, 'Employee locations', entityPath('User'), {
        ...buildQueryParams({ entityName: 'User', select: PLACE_SELECT, orderBy: [{ field: 'userId', direction: 'asc' }], top: PLACE_PAGE_SIZE }),
        $skip: String(page * PLACE_PAGE_SIZE),
      });
      const rows = results(d);
      for (const e of rows) {
        const name = str(e.displayName) || `${str(e.firstName)} ${str(e.lastName)}`.trim() || str(e.userId);
        places.push({
          userId: str(e.userId),
          displayName: name,
          ...(opt(e.title) && { jobTitle: opt(e.title) }),
          ...(opt(e.department) && { department: opt(e.department) }),
          ...(opt(e.location) && { location: opt(e.location) }),
          ...(opt(e.city) && { city: opt(e.city) }),
          ...(opt(e.country) && { country: opt(e.country) }),
        });
      }
      if (rows.length < PLACE_PAGE_SIZE) break;
    }
    return places;
  }

  /**
   * Reads an entity without naming its fields, for entities whose properties differ between
   * tenants. The property names of the first record are logged once, so the mapping can be checked.
   */
  private async readAll(ctx: SapCallContext, what: string, entityName: string, params: Record<string, string>): Promise<ODataEntity[]> {
    const rows = results(await this.get(ctx, what, entityPath(entityName), { $format: 'json', ...params }));
    // How many records came back tells an empty answer apart from a mapping that dropped them.
    this.cfg.logger.info('sf.entity_read', { entity: entityName, records: rows.length });
    if (rows[0] && !this.shapesLogged.has(entityName)) {
      this.shapesLogged.add(entityName);
      this.cfg.logger.info('sf.entity_shape', { entity: entityName, fields: Object.keys(rows[0]).filter((k) => k !== '__metadata') });
    }
    return rows;
  }

  async getTimeOffBalances(ctx: SapCallContext, userId: string): Promise<TimeOffBalance[]> {
    // SuccessFactors answers a balance query only for one account type at a time, so the employee's
    // open time accounts are read first.
    const what = `Time off balances of ${userId}`;
    const accounts = await this.readAll(ctx, what, 'TimeAccount', { $filter: buildFilter({ field: 'userId', operator: 'eq', value: userId }), $top: '100' });
    const today = new Date().toISOString().slice(0, 10);
    const open = accounts.filter((a) => a.accountClosed !== true && str(a.accountClosed) !== 'true' && (odataDate(a.endDate) ?? '9999') >= today);
    const types = [...new Set(open.map((a) => str(a.accountType)).filter(Boolean))].slice(0, BALANCE_ACCOUNT_TYPES);
    const perType = await Promise.all(
      types.map((type) =>
        this.readAll(ctx, what, 'EmpTimeAccountBalance', {
          $filter: buildFilter({ and: [{ field: 'userId', operator: 'eq', value: userId }, { field: 'timeAccountType', operator: 'eq', value: type }] }),
          $top: '10',
        }).then((rows) => ({ type, rows })),
      ),
    );
    return perType.flatMap(({ type, rows }) => {
      const balances = rows.map((e) => Number.parseFloat(str(e.balance))).filter(Number.isFinite);
      if (!balances.length) return [];
      // Several accounts of one type (this year's and a carried-over one) count as one balance.
      const balance = Math.round(balances.reduce((sum, b) => sum + b, 0) * 100) / 100;
      return [{ account: accountName(type), balance, unit: rows.some((e) => /hour/i.test(str(e.timeUnit))) ? ('HOURS' as const) : ('DAYS' as const) }];
    });
  }

  async listAbsences(ctx: SapCallContext, userIds: string[], from: string, to: string): Promise<Absence[]> {
    if (!userIds.length) return [];
    const d = await this.get(
      ctx,
      'Absences',
      entityPath('EmployeeTime'),
      buildQueryParams({
        entityName: 'EmployeeTime',
        select: ['userId', 'timeType', 'startDate', 'endDate', 'quantityInDays', 'approvalStatus'],
        filter: {
          and: [
            { or: userIds.slice(0, ABSENCE_USERS).map((id): QueryFilter => ({ field: 'userId', operator: 'eq', value: id })) },
            { field: 'startDate', operator: 'le', value: `datetime'${to}T00:00:00'` },
            { field: 'endDate', operator: 'ge', value: `datetime'${from}T00:00:00'` },
          ],
        },
        orderBy: [{ field: 'startDate', direction: 'asc' }],
        top: 200,
      }),
    );
    return results(d).map((e) => {
      const days = Number.parseFloat(str(e.quantityInDays));
      return {
        userId: str(e.userId),
        timeType: str(e.timeType) || 'Time off',
        startDate: odataDate(e.startDate) ?? '',
        endDate: odataDate(e.endDate) ?? '',
        ...(Number.isFinite(days) && { days }),
        status: absenceStatus(e.approvalStatus),
      };
    });
  }

  async listOpenPositions(ctx: SapCallContext, managerId: string): Promise<OpenPosition[]> {
    const job = await this.get(
      ctx,
      `Position of ${managerId}`,
      entityPath('EmpJob'),
      buildQueryParams({ entityName: 'EmpJob', select: ['position'], filter: { field: 'userId', operator: 'eq', value: managerId }, top: 1 }),
    );
    const position = str(results(job)[0]?.position);
    if (!position) return [];
    const rows = await this.readAll(ctx, `Open positions below ${managerId}`, 'Position', {
      $filter: buildFilter({ and: [{ field: 'parentPosition/code', operator: 'eq', value: position }, { field: 'vacant', operator: 'eq', value: true }] }),
      $top: '50',
    });
    return rows.map((e) => {
      const title = first(e, 'externalName_defaultValue', 'externalName_en_US', 'externalName_localized', 'positionTitle');
      return { code: str(e.code), ...(title && { title }), ...(opt(e.department) && { department: opt(e.department) }), ...(opt(e.location) && { location: opt(e.location) }) };
    });
  }

  async listTimeTypes(ctx: SapCallContext): Promise<TimeType[]> {
    const rows = await this.readAll(ctx, 'Time types', 'TimeType', { $top: '200' });
    return rows
      .map((e) => {
        const code = first(e, 'externalCode', 'code') ?? '';
        return { code, name: first(e, 'externalName_defaultValue', 'externalName_en_US', 'externalName_localized', 'externalName') ?? code };
      })
      .filter((t) => t.code);
  }

  /**
   * Creates the absence through `/upsert`, the way SuccessFactors takes Employee Central records.
   * The answer carries a status per record: an HTTP 200 can still hold a refusal, which is passed on.
   */
  async requestTimeOff(ctx: SapCallContext, request: NewTimeOff): Promise<{ id: string }> {
    const externalCode = `PRW${Date.now().toString(36).toUpperCase()}${randomUUID().slice(0, 8).toUpperCase()}`;
    const record = {
      __metadata: { uri: 'EmployeeTime' },
      externalCode,
      userId: request.userId,
      timeType: request.timeType,
      startDate: toODataDate(request.startDate),
      endDate: toODataDate(request.endDate),
      ...(request.comment && { comment: request.comment }),
    };
    const d = await this.send(ctx, 'the leave request', 'post', '/upsert', { $format: 'json' }, 'application/json', record);
    const result = (Array.isArray(d) ? d : results(d))[0] as { status?: unknown; message?: unknown; key?: unknown } | undefined;
    if (!result || str(result.status).toUpperCase() !== 'OK') {
      const reason = str(result?.message).replace(/\s+/g, ' ').slice(0, 300);
      throw new SapError('BUSINESS_RULE', `SuccessFactors rejected the leave request${reason ? `: ${reason}` : '.'}`);
    }
    return { id: externalCode };
  }

  /**
   * Requests waiting for the caller's decision, from two places. `MyPendingWorkflow` holds the
   * requests where the caller is the approver of record, but an item forwarded or delegated to the
   * caller appears only in their to-do list (`TodoEntryV2`), as "Requests Waiting for My Approval"
   * with the workflow request in `subjectId`. Both are read and merged by request id; when one of
   * them cannot be read, the other still counts.
   */
  async listPendingApprovals(ctx: SapCallContext): Promise<ApprovalRequest[]> {
    const [workflows, todos] = await Promise.allSettled([this.pendingWorkflows(ctx), this.approvalTodos(ctx)]);
    if (workflows.status === 'rejected' && todos.status === 'rejected') throw workflows.reason;
    const merged = new Map<string, ApprovalRequest>();
    for (const r of [...(workflows.status === 'fulfilled' ? workflows.value : []), ...(todos.status === 'fulfilled' ? todos.value : [])]) {
      if (!merged.has(r.id)) merged.set(r.id, r);
    }
    return [...merged.values()];
  }

  private async approvalTodos(ctx: SapCallContext): Promise<ApprovalRequest[]> {
    const me = await this.whoAmI(ctx);
    const rows = await this.readAll(ctx, 'Your to-do list', 'TodoEntryV2', { $filter: buildFilter({ field: 'userId', operator: 'eq', value: me }), $top: '100' });
    return rows
      .filter((e) => /approv/i.test(`${str(e.todoEntryName)} ${str(e.categoryLabel)}`) && !/^(3|completed|closed)$/i.test(str(e.status)))
      .map((e) => {
        const requestedOn = odataDate(e.createdDate ?? e.lastModifiedDateTime);
        const detail = first(e, 'subjectFullName', 'subjectUserName', 'todoEntryName');
        return {
          id: str(e.subjectId),
          title: first(e, 'categoryLabel', 'todoEntryName') ?? 'Workflow request',
          ...(detail && { detail }),
          ...(requestedOn && { requestedOn }),
        };
      })
      .filter((r) => /^\d+$/.test(r.id));
  }

  private async pendingWorkflows(ctx: SapCallContext): Promise<ApprovalRequest[]> {
    const rows = await this.readAll(ctx, 'Your pending approvals', 'MyPendingWorkflow', { $top: '50' });
    return rows
      .map((e) => {
        const subjectUserId = first(e, 'subjectUserId', 'subjectId');
        const subjectName = first(e, 'subjectUserName', 'subjectFullName', 'subjectName');
        const detail = first(e, 'todoSubjectLine', 'description', 'eventReason');
        const requestedOn = odataDate(e.receivedOn ?? e.createdOn ?? e.createdDateTime);
        return {
          id: str(e.wfRequestId),
          ...(subjectUserId && { subjectUserId }),
          ...(subjectName && { subjectName }),
          title: first(e, 'requestType', 'eventReason', 'subject', 'module') ?? 'Workflow request',
          ...(detail && { detail }),
          ...(requestedOn && { requestedOn }),
        };
      })
      .filter((r) => /^\d+$/.test(r.id));
  }

  async decideApproval(ctx: SapCallContext, requestId: string, decision: 'APPROVE' | 'DECLINE', comment?: string): Promise<void> {
    if (!/^\d{1,18}$/.test(requestId)) throw new SapError('INVALID_INPUT', 'The request id is not valid.');
    // Function imports of the workflow API; the request id is an Edm.Int64 literal.
    await this.send(ctx, `the decision on request ${requestId}`, 'post', decision === 'APPROVE' ? '/approveWfRequest' : '/rejectWfRequest', {
      $format: 'json',
      wfRequestId: `${requestId}L`,
      ...(comment && { comment: formatLiteral(comment) }),
    });
  }

  async readEntity(ctx: SapCallContext, read: EntityRead): Promise<EntityQueryResult> {
    const d = (await this.get(ctx, `${read.entityName} records`, entityPath(read.entityName), {
      $format: 'json',
      ...(read.select?.length && { $select: read.select.map(assertSafeFieldName).join(',') }),
      ...(read.filter && { $filter: buildFilter(read.filter) }),
      ...(read.orderBy?.length && { $orderby: read.orderBy.map((o) => `${assertSafeFieldName(o.field)} ${o.direction}`).join(',') }),
      $top: String(read.top),
    })) as { results?: ODataEntity[]; __next?: unknown };
    // Scalar values only: `__metadata`, deferred navigations and nested records are dropped.
    const records = results(d).map((e) =>
      Object.fromEntries(
        Object.entries(e)
          .filter(([name, v]) => name !== '__metadata' && (v === null || typeof v !== 'object'))
          .map(([name, v]) => [name, typeof v === 'string' && v.startsWith('/Date(') ? (odataDate(v) ?? v) : v]),
      ),
    );
    return { records, hasMore: Boolean(d.__next) };
  }

  async describeEntity(ctx: SapCallContext, entityName: string): Promise<EntityField[]> {
    const path = entityPath(entityName);
    const name = path.slice(1);
    // SuccessFactors serves the metadata of a single entity; the whole $metadata document is several megabytes.
    const xml = await this.send(ctx, `The definition of ${name}`, 'get', `${path}/$metadata`, {}, 'application/xml');
    const type = typeof xml === 'string' ? new RegExp(`<EntityType\\b[^>]*\\bName="${name}"[^>]*>([\\s\\S]*?)</EntityType>`).exec(xml)?.[1] : undefined;
    if (!type) throw new SapError('NOT_FOUND', `The definition of ${name} was not found in SuccessFactors.`);
    const keys = new Set([...type.matchAll(/<PropertyRef\b[^>]*\bName="([^"]+)"/g)].map((m) => m[1]!));
    return [...type.matchAll(/<Property\b([^>]*)>/g)].flatMap((m) => {
      const attr = (attribute: string) => new RegExp(`\\b${attribute}="([^"]*)"`).exec(m[1]!)?.[1];
      const field = attr('Name');
      if (!field) return [];
      const fieldType = attr('Type')?.replace(/^Edm\./, '');
      return [{ name: field, ...(fieldType && { type: fieldType }), ...(keys.has(field) && { key: true }), ...(attr('sap:filterable') === 'false' && { filterable: false }) }];
    });
  }

  async queryEntity(ctx: SapCallContext, query: EntityQuery): Promise<EntityQueryResult> {
    const d = (await this.get(ctx, `${query.entityName} records`, entityPath(query.entityName), buildQueryParams(query))) as { results?: ODataEntity[]; __next?: unknown };
    // Only the selected fields are passed on; `__metadata` and deferred navigations are dropped.
    const value = (v: unknown) => (typeof v === 'string' && v.startsWith('/Date(') ? (odataDate(v) ?? v) : typeof v === 'object' ? null : (v ?? null));
    const records = results(d).map((e) => Object.fromEntries(query.select.map((field) => [field, value(e[field])])));
    return { records, hasMore: Boolean(d.__next) };
  }
}
