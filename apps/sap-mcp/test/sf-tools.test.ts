import { UIComponentSchema } from '@prowess/contracts';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MockMailGateway } from '../src/outlook/mock-gateway.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import { SapError, type SapCallContext } from '../src/sap/model.js';
import { MockSfGateway } from '../src/sf/mock-gateway.js';
import { EntityPolicy, REDACTED } from '../src/sf/policy.js';
import { buildFilter, buildQueryParams, entityKeyPath, entityPath, formatLiteral } from '../src/sf/query-builder.js';
import { buildRegistry } from '../src/tools/registry.js';
import type { ToolResultPayload } from '../src/tools/types.js';

const outlook = { gateway: new MockMailGateway(0), allowedRecipientDomains: [] as string[] };

const SECRET = 'test-secret-'.padEnd(48, 'x');
const as = (sub: string) => ({ principal: { sub }, correlationId: 't' }) as unknown as SapCallContext;
const alex = as('alex.morgan@prowess.example'); // manager of Jordan, Mei and Luis
const jordan = as('jordan.lee@prowess.example'); // no reports
const sam = as('sam.rivera@prowess.example'); // HR
const registry = buildRegistry(new Set(['sf'] as const));
const sf = { gateway: new MockSfGateway(0), policy: new EntityPolicy() };

async function run(ctx: SapCallContext, name: string, args: Record<string, unknown> = {}): Promise<ToolResultPayload> {
  const result = await registry.get(name)!.run(args as never, { sap: ctx, gateway: new MockSapGateway(0), sf, outlook });
  for (const c of result.components ?? []) expect(UIComponentSchema.safeParse(c).error?.issues, `${name} component ${c.type}`).toBeUndefined();
  return result;
}
const rows = (r: ToolResultPayload, index = 0) => (r.components![index]!.data as { rows: Record<string, unknown>[] }).rows;

describe('SuccessFactors query builder', () => {
  it('escapes string literals', () => {
    expect(buildFilter({ field: 'lastName', operator: 'eq', value: "O'Brien" })).toBe("lastName eq 'O''Brien'");
  });

  it('builds select, filter, order and top', () => {
    const params = buildQueryParams({
      entityName: 'User',
      select: ['userId', 'manager/userId'],
      filter: { and: [{ field: 'status', operator: 'eq', value: 't' }, { or: [{ field: 'firstName', operator: 'contains', value: 'an' }, { field: 'lastName', operator: 'startswith', value: 'Le' }] }] },
      orderBy: [{ field: 'displayName', direction: 'asc' }],
      top: 10,
    });
    expect(params).toEqual({
      $format: 'json',
      $select: 'userId,manager/userId',
      $filter: "(status eq 't' and (substringof('an',firstName) or startswith(lastName,'Le')))",
      $orderby: 'displayName asc',
      $top: '10',
    });
  });

  it('rejects injection through field names', () => {
    expect(() => buildFilter({ field: "userId eq 'x' or '1' eq '1", operator: 'eq', value: 'y' })).toThrow(/not a valid field name/);
    expect(() => buildQueryParams({ entityName: 'User', select: ['userId,password'], top: 1 })).toThrow();
    expect(() => buildQueryParams({ entityName: 'User', select: ['userId'], orderBy: [{ field: 'userId asc, password', direction: 'asc' }], top: 1 })).toThrow();
  });

  it('passes a date-time literal only when it cannot close the literal early', () => {
    expect(formatLiteral("datetimeoffset'2024-01-01T00:00:00Z'")).toBe("datetimeoffset'2024-01-01T00:00:00Z'");
    expect(() => formatLiteral("datetimeoffset'2020-01-01T00:00:00Z or x'")).toThrow();
    expect(formatLiteral("datetimeoffset'2020' or userId eq 'x")).toBe("'datetimeoffset''2020'' or userId eq ''x'");
  });

  it('reduces entity names and keys to safe path segments', () => {
    expect(entityPath('EmpJob?$top=9999')).toBe('/EmpJobtop9999');
    expect(entityKeyPath('User', "1')/x")).toBe("/User('1'')/x')");
    expect(() => entityPath('../')).toThrow();
  });
});

describe('SuccessFactors entity policy', () => {
  const policy = new EntityPolicy();

  it('allows listed entities and fields only', () => {
    expect(policy.assertReadable('EmpJob', ['userId', 'jobTitle'], ['startDate']).entityName).toBe('EmpJob');
    expect(() => policy.assertReadable('PerPersonal', ['dateOfBirth'])).toThrow(/not on the SuccessFactors allow-list/);
    expect(() => policy.assertReadable('EmpJob', ['userId', 'payGrade'])).toThrow(/payGrade of EmpJob are not allowed/);
    expect(() => policy.assertReadable('User', ['userId'], ['password'])).toThrow(/not allowed/);
  });

  it('redacts protected fields and refuses them as a condition', () => {
    const user = policy.assertReadable('User', ['userId', 'email']);
    expect(policy.redact(user, { userId: '1', email: 'a@b.example' })).toEqual({ userId: '1', email: REDACTED });
    expect(() => policy.assertReadable('User', ['userId'], ['email'])).toThrow(/protected/);
  });

  it('keeps an unfiltered query to a small page', () => {
    expect(policy.boundedTop(undefined, false)).toBe(50);
    expect(policy.boundedTop(200, false)).toBe(50);
    expect(policy.boundedTop(200, true)).toBe(200);
    expect(policy.boundedTop(5, false)).toBe(5);
  });

  it('is replaced by SF_ENTITY_ALLOWLIST_JSON and fails closed on a bad list', () => {
    const custom = EntityPolicy.fromJson(JSON.stringify({ PerEmail: { operations: ['read'], fields: ['personIdExternal', 'emailAddress'], sensitiveFields: ['emailAddress'] } }));
    expect(custom.list().map((e) => e.entityName)).toEqual(['PerEmail']);
    expect(() => custom.assertReadable('User', ['userId'])).toThrow();
    expect(() => EntityPolicy.fromJson('{ not json')).toThrow(/not valid JSON/);
    expect(() => EntityPolicy.fromJson(JSON.stringify({ Foo: { operations: ['read', 'drop'], fields: ['a'] } }))).toThrow(/invalid operations/);
    expect(() => EntityPolicy.fromJson(JSON.stringify({ '*': { operations: ['read'], fields: ['a'] } }))).toThrow(/wildcards are not supported/);
    expect(() => EntityPolicy.fromJson(JSON.stringify({ Foo: { operations: ['read'], allowAllFields: true } }))).toThrow(/allowAllFields is not supported/);
  });
});

describe('SuccessFactors tools', () => {
  it('names every tool after the sf domain; only the leave request and the two decisions change anything', () => {
    const tools = [...registry.values()].filter((t) => t.domain === 'sf' && !t.requiredRole);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'sf_approveRequest',
      'sf_declineRequest',
      'sf_getDirectReports',
      'sf_getEmployee',
      'sf_getJobHistory',
      'sf_getMyProfile',
      'sf_getReportingLine',
      'sf_getTeamOverview',
      'sf_getTimeOff',
      'sf_listApprovals',
      'sf_listEmployeeLocations',
      'sf_listEntities',
      'sf_listTimeTypes',
      'sf_queryEntity',
      'sf_requestTimeOff',
      'sf_searchEmployees',
      'sf_showEmployeeMap',
    ]);
    expect(tools.filter((t) => t.risk !== 'READ').map((t) => t.name).sort()).toEqual(['sf_approveRequest', 'sf_declineRequest', 'sf_requestTimeOff']);
    // The whole workforce is too large for a model: only the orchestrator may read it.
    expect(tools.filter((t) => t.internal).map((t) => t.name)).toEqual(['sf_listEmployeeLocations']);
  });

  it('prepares the employee map by work location without handing the employees to the model', async () => {
    const all = await run(jordan, 'sf_showEmployeeMap');
    expect(all.data.summary).toBe('The map shows the 9 employee(s) by work location, across 2 location(s).');
    expect(all.data.locations).toEqual([{ location: 'Riyadh', employees: 7 }, { location: 'Jeddah', employees: 2 }]);
    expect(all.components).toEqual([{ type: 'employee_map', data: { title: 'All employees', employees: 9 } }]);
    expect(JSON.stringify(all.data)).not.toMatch(/Jordan|@/);

    const jeddah = await run(jordan, 'sf_showEmployeeMap', { location: 'jeddah' });
    expect(jeddah.components).toEqual([{ type: 'employee_map', data: { title: 'Employees at jeddah', employees: 2, location: 'jeddah' } }]);
    expect((await run(jordan, 'sf_showEmployeeMap', { location: 'Dammam' })).components).toEqual([]);

    const places = (await run(jordan, 'sf_listEmployeeLocations')).data.employees as { userId: string; city: string; country: string }[];
    expect(places).toHaveLength(9);
    expect(places.find((p) => p.userId === '100102')).toMatchObject({ city: 'Jeddah', country: 'SA' });
    // Inactive employees are not on the map.
    expect(places.map((p) => p.userId)).not.toContain('100202');
  });

  it('shows time off balances and upcoming absences, for oneself and one’s team only', async () => {
    const r = await run(jordan, 'sf_getTimeOff');
    expect(r.data.summary).toBe('**Jordan Lee** has 14.5 days of Annual leave and 8 days of Sick leave left.');
    const card = r.components![0] as { type: string; data: { upcoming: { status: string; days: number }[]; balances: unknown[] } };
    expect(card.type).toBe('time_off');
    expect(card.data.balances).toHaveLength(2);
    expect(card.data.upcoming.map((a) => a.status)).toEqual(['APPROVED', 'PENDING']);
    expect((await run(alex, 'sf_getTimeOff', { userId: '100102' })).components![0]!.type).toBe('time_off');
    await expect(run(jordan, 'sf_getTimeOff', { userId: '100101' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('requests leave for the caller after a preview, and routes it to the manager', async () => {
    const backend = { gateway: new MockSfGateway(0), policy: new EntityPolicy() };
    const ctx = (sap: SapCallContext) => ({ sap, gateway: new MockSapGateway(0), sf: backend, outlook });
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const args = { timeType: 'ANNUAL', startDate: day(40), endDate: day(42) };

    const types = await registry.get('sf_listTimeTypes')!.run({} as never, ctx(jordan));
    expect((types.data.timeTypes as { code: string }[]).map((t) => t.code)).toEqual(['ANNUAL', 'SICK', 'UNPAID']);

    const preview = await registry.get('sf_requestTimeOff')!.preview!(args as never, ctx(jordan));
    expect(preview).toMatchObject({ action: 'Request time off', proposedChange: `Annual leave from ${args.startDate} to ${args.endDate} (3 calendar day(s)).` });

    const done = await registry.get('sf_requestTimeOff')!.run(args as never, ctx(jordan));
    expect(done.data.summary).toBe(`Annual leave from ${args.startDate} to ${args.endDate} was requested in SuccessFactors.`);
    const upcoming = (await registry.get('sf_getTimeOff')!.run({} as never, ctx(jordan))).data.upcoming as { startDate: string; status: string }[];
    expect(upcoming.find((a) => a.startDate === args.startDate)).toMatchObject({ status: 'PENDING' });
    // It waits in the manager's approvals.
    const items = (await registry.get('sf_listApprovals')!.run({} as never, ctx(alex))).data.requests as { subjectName: string; detail: string }[];
    expect(items.some((r) => r.subjectName === 'Jordan Lee' && r.detail.startsWith(args.startDate))).toBe(true);

    // SuccessFactors' refusal is passed on; the dates are checked before anything is sent.
    await expect(registry.get('sf_requestTimeOff')!.run(args as never, ctx(jordan))).rejects.toMatchObject({ code: 'BUSINESS_RULE', message: expect.stringContaining('overlaps') });
    await expect(registry.get('sf_requestTimeOff')!.run({ ...args, timeType: 'SABBATICAL' } as never, ctx(jordan))).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
    await expect(registry.get('sf_requestTimeOff')!.preview!({ ...args, endDate: day(39) } as never, ctx(jordan))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(registry.get('sf_requestTimeOff')!.preview!({ ...args, startDate: day(400), endDate: day(401) } as never, ctx(jordan))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('summarizes a team with who is out today and the open positions', async () => {
    const r = await run(alex, 'sf_getTeamOverview');
    expect(r.data.summary).toBe('**Alex Morgan** has 3 direct report(s), Jordan Lee out today, 1 open position(s).');
    const data = r.components![0]!.data as { headcount: number; outToday: number; openRoles: number; members: { userId: string; note?: string }[]; openPositions: { code: string }[] };
    expect(r.components![0]!.type).toBe('team_overview');
    expect(data).toMatchObject({ headcount: 3, outToday: 1, openRoles: 1, openPositions: [{ code: 'P2041' }] });
    expect(data.members.find((m) => m.userId === '100102')!.note).toMatch(/^Out until [A-Z][a-z]{2} \d{1,2}$/);
    expect(data.members.find((m) => m.userId === '100103')!.note).toBeUndefined();
  });

  it('shows a team without the figures SuccessFactors does not provide', async () => {
    const gateway = new MockSfGateway(0);
    gateway.listAbsences = async () => {
      throw new SapError('INVALID_INPUT', 'SuccessFactors rejected the request for Absences.');
    };
    gateway.listOpenPositions = async () => {
      throw new SapError('NOT_AUTHORIZED', 'SuccessFactors denied access to Open positions.');
    };
    const r = await registry.get('sf_getTeamOverview')!.run({} as never, { sap: alex, gateway: new MockSapGateway(0), sf: { gateway, policy: new EntityPolicy() }, outlook });
    expect(r.data.summary).toBe('**Alex Morgan** has 3 direct report(s).');
    expect(UIComponentSchema.safeParse(r.components![0]).success).toBe(true);
    expect(r.components![0]!.data).not.toHaveProperty('outToday');
    expect(r.components![0]!.data).not.toHaveProperty('openRoles');
  });

  it('lists the requests waiting for the caller and decides them once', async () => {
    const backend = { gateway: new MockSfGateway(0), policy: new EntityPolicy() };
    const call = (ctx: SapCallContext, name: string, args: Record<string, unknown> = {}) => registry.get(name)!.run(args as never, { sap: ctx, gateway: new MockSapGateway(0), sf: backend, outlook });

    const list = await call(alex, 'sf_listApprovals');
    expect(list.data.summary).toBe('2 request(s) are waiting for your decision.');
    expect(UIComponentSchema.safeParse(list.components![0]).success).toBe(true);
    expect((list.components![0]!.data as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(['4001', '4002']);
    expect((await call(jordan, 'sf_listApprovals')).components).toEqual([]);

    const preview = await registry.get('sf_approveRequest')!.preview!({ requestId: '4001' } as never, { sap: alex, gateway: new MockSapGateway(0), sf: backend, outlook });
    expect(preview).toMatchObject({ action: 'Approve request', businessObject: { type: 'WorkflowRequest', id: '4001' } });
    expect(preview.proposedChange).toMatch(/^Approve: Annual leave of Jordan Lee \(/);

    // Only the approver may decide, and a request can be decided once.
    await expect(call(jordan, 'sf_approveRequest', { requestId: '4001' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await call(alex, 'sf_approveRequest', { requestId: '4001' })).data.summary).toMatch(/^Approved: Annual leave of Jordan Lee/);
    await expect(call(alex, 'sf_approveRequest', { requestId: '4001' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The approved leave is no longer pending on the employee's time off.
    expect(((await call(jordan, 'sf_getTimeOff')).data.upcoming as { status: string }[]).map((a) => a.status)).toEqual(['APPROVED', 'APPROVED']);

    expect((await call(alex, 'sf_declineRequest', { requestId: '4002', comment: 'Budget is not approved yet' })).data).toMatchObject({ decision: 'DECLINED' });
    expect((await call(alex, 'sf_listApprovals')).data.summary).toBe('No request is waiting for your decision.');
  });

  it('resolves the caller to their own profile and keeps the e-mail address away from the model', async () => {
    const r = await run(jordan, 'sf_getMyProfile');
    expect(r.data.summary).toBe('You are **Jordan Lee** (100102), Accounts Payable Accountant in Accounts Payable, Jeddah. Reports to Alex Morgan.');
    expect(r.components![0]).toMatchObject({ type: 'employee', data: { userId: '100102', email: 'jordan.lee@prowess.example', managerId: '100101' } });
    expect(JSON.stringify(r.data)).not.toContain('@');
    expect(r.source).toMatchObject({ system: 'SF-MOCK', objectType: 'Employee', objectId: '100102', mock: true });
  });

  it('refuses a login that has no SuccessFactors user', async () => {
    await expect(run(as('stranger@prowess.example'), 'sf_getMyProfile')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists the direct reports of the caller or of a named manager', async () => {
    const mine = await run(alex, 'sf_getDirectReports');
    expect(mine.data.summary).toBe('**Alex Morgan** has 3 direct report(s).');
    expect(rows(mine).map((r) => r.userId)).toEqual(['100102', '100103', '100104']);
    // Hannah Schmidt is inactive and left out.
    expect(rows(await run(jordan, 'sf_getDirectReports', { userId: '100020' })).map((r) => r.name)).toEqual(['Omar Haddad']);
    const none = await run(jordan, 'sf_getDirectReports');
    expect(none.data.summary).toBe('**Jordan Lee** has no direct reports.');
    expect(none.components).toEqual([]);
  });

  it('walks the reporting line to the top', async () => {
    const r = await run(jordan, 'sf_getReportingLine');
    expect(r.data.summary).toBe('**Jordan Lee** reports to Alex Morgan, who reports to Priya Nair, who reports to Dana Whitfield.');
    expect(r.components![0]).toMatchObject({ type: 'reporting_line', data: { employee: { userId: '100102' }, managers: [{ userId: '100101' }, { userId: '100010' }, { userId: '100001' }] } });
    expect((await run(jordan, 'sf_getReportingLine', { userId: '100001' })).data.summary).toBe('**Dana Whitfield** has no manager on record.');
  });

  it('shows job history for oneself, one’s reports and HR, and lets SuccessFactors deny the rest', async () => {
    const own = await run(jordan, 'sf_getJobHistory');
    expect(own.data.summary).toBe('**Jordan Lee** has 2 job record(s) since 2022-04-18.');
    expect(own.components![0]).toMatchObject({ type: 'timeline', data: { events: [{ date: '2024-07-01', detail: 'Transfer (Location change) · Jeddah · current' }, { date: '2022-04-18' }] } });
    expect((await run(alex, 'sf_getJobHistory', { userId: '100102' })).data.history).toHaveLength(2);
    expect((await run(sam, 'sf_getJobHistory', { userId: '100102' })).data.history).toHaveLength(2);
    await expect(run(jordan, 'sf_getJobHistory', { userId: '100101' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED', message: expect.stringContaining('job history of Alex Morgan') });
  });

  it('searches employees by a part of the name', async () => {
    expect(rows(await run(jordan, 'sf_searchEmployees', { query: 'tanaka' }))).toEqual([{ userId: '100103', name: 'Mei Tanaka', jobTitle: 'Senior Accounts Payable Accountant', department: 'Accounts Payable', location: 'Riyadh' }]);
    expect((await run(jordan, 'sf_searchEmployees', { query: 'zzz' })).components).toEqual([]);
  });

  it('queries allow-listed entities with redaction and row-level permissions', async () => {
    const users = await run(jordan, 'sf_queryEntity', { entityName: 'User', select: ['userId', 'displayName', 'email'], filters: [{ field: 'department', operator: 'eq', value: 'Internal Audit' }] });
    expect(users.data.records).toEqual([{ userId: '100110', displayName: 'Casey Kim', email: REDACTED }]);
    expect(rows(users)).toEqual([{ userId: '100110', displayName: 'Casey Kim', email: REDACTED }]);

    const query = { entityName: 'EmpJob', select: ['userId', 'startDate', 'jobTitle'], orderBy: [{ field: 'startDate', direction: 'desc' }] };
    // Jordan sees only his own job records; HR sees all of them.
    expect(((await run(jordan, 'sf_queryEntity', query)).data.records as { userId: string }[]).map((r) => r.userId)).toEqual(['100102', '100102']);
    expect((await run(sam, 'sf_queryEntity', query)).data.records).toHaveLength(7);
    expect((await run(sam, 'sf_queryEntity', { ...query, top: 3 })).data).toMatchObject({ hasMore: true, summary: '3 EmpJob record(s), more exist beyond the first 3.' });
  });

  it('leaves out a field the tenant does not have and reads the rest', async () => {
    const gateway = new MockSfGateway(0);
    const query = gateway.queryEntity.bind(gateway);
    gateway.queryEntity = async (ctx, q) => {
      if (q.select.includes('description') || JSON.stringify(q.filter ?? {}).includes('description')) throw new SapError('INVALID_INPUT', 'SuccessFactors rejected the request for FODepartment records: [COE0021]Invalid property names: FODepartment/description. Please check the property name.');
      return query(ctx, q);
    };
    const backend = { gateway, policy: new EntityPolicy() };
    const call = (args: Record<string, unknown>) => registry.get('sf_queryEntity')!.run(args as never, { sap: sam, gateway: new MockSapGateway(0), sf: backend, outlook });

    const r = await call({ entityName: 'FODepartment', select: ['externalCode', 'name', 'description'] });
    expect(r.data.summary).toBe('5 FODepartment record(s). description does not exist in this tenant and was left out.');
    expect((r.components![0]!.data as { columns: { key: string }[] }).columns.map((c) => c.key)).toEqual(['externalCode', 'name']);
    // A missing field the filter needs cannot be dropped.
    await expect(call({ entityName: 'FODepartment', select: ['externalCode'], filters: [{ field: 'description', operator: 'eq', value: 'x' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call({ entityName: 'FODepartment', select: ['description'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses entities and fields outside the allow-list before SuccessFactors is called', async () => {
    await expect(run(sam, 'sf_queryEntity', { entityName: 'EmpCompensation', select: ['userId'] })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(run(sam, 'sf_queryEntity', { entityName: 'User', select: ['userId'], filters: [{ field: 'email', operator: 'contains', value: 'a' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const list = await run(sam, 'sf_listEntities');
    expect((list.data.entities as { entity: string }[]).map((e) => e.entity)).toContain('EmpJob');
  });
});

describe('SuccessFactors configuration', () => {
  it('defaults to the mock and reads the SuccessFactors settings', () => {
    expect(loadConfig({ SERVICE_ASSERTION_SECRET: SECRET }).sf).toEqual({ mode: 'mock', destinationName: 'SF_ODATA', systemId: 'SF-MOCK', userMapping: 'email' });
    const cfg = loadConfig({ SERVICE_ASSERTION_SECRET: SECRET, PROWESS_ENV: 'QA', MCP_DOMAINS: 'sf', SF_MODE: 'odata', SF_DESTINATION: 'SFSF', SF_USER_MAPPING: 'username' });
    expect([...cfg.domains]).toEqual(['sf']);
    expect(cfg.sf).toEqual({ mode: 'odata', destinationName: 'SFSF', systemId: 'SF-QA', userMapping: 'username' });
    expect(() => loadConfig({ SERVICE_ASSERTION_SECRET: SECRET, SF_USER_MAPPING: 'phone' })).toThrow(/SF_USER_MAPPING/);
  });

  it('never serves mock HR data in PROD', () => {
    const prod = { SERVICE_ASSERTION_SECRET: SECRET, PROWESS_ENV: 'PROD', SAP_MODE: 'odata' };
    expect(loadConfig(prod).domains.has('sf')).toBe(false);
    expect(() => loadConfig({ ...prod, MCP_DOMAINS: 'sf' })).toThrow('SF_MODE=mock is not permitted in PROD');
    expect(loadConfig({ ...prod, MCP_DOMAINS: 'sf', SF_MODE: 'odata' }).domains.has('sf')).toBe(true);
  });
});

describe('confirmation of a SuccessFactors change', () => {
  it('names SuccessFactors as the target system, not the S/4HANA connection', async () => {
    // S/4HANA in mock mode next to a live SuccessFactors tenant, as in the DEV space.
    const live = new MockSfGateway(0);
    Object.defineProperties(live, { systemId: { value: 'SF-DEV' }, mock: { value: false } });
    const ctx = { sap: jordan, gateway: new MockSapGateway(0), sf: { gateway: live, policy: new EntityPolicy() }, outlook };
    const day = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const preview = await buildRegistry(new Set(['sf', 'shared'] as const)).get('system_previewAction')!.run({ tool: 'sf_requestTimeOff', arguments: { timeType: 'SICK', startDate: day, endDate: day } } as never, ctx);
    expect(preview.data).toMatchObject({ targetSystem: 'SF-DEV', mock: false });
  });
});
