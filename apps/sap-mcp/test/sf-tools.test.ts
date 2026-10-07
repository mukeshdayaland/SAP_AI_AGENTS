import { UIComponentSchema } from '@prowess/contracts';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import type { SapCallContext } from '../src/sap/model.js';
import { MockSfGateway } from '../src/sf/mock-gateway.js';
import { EntityPolicy, REDACTED } from '../src/sf/policy.js';
import { buildFilter, buildQueryParams, entityKeyPath, entityPath, formatLiteral } from '../src/sf/query-builder.js';
import { buildRegistry } from '../src/tools/registry.js';
import type { ToolResultPayload } from '../src/tools/types.js';

const SECRET = 'test-secret-'.padEnd(48, 'x');
const as = (sub: string) => ({ principal: { sub }, correlationId: 't' }) as unknown as SapCallContext;
const alex = as('alex.morgan@prowess.example'); // manager of Jordan, Mei and Luis
const jordan = as('jordan.lee@prowess.example'); // no reports
const sam = as('sam.rivera@prowess.example'); // HR
const registry = buildRegistry(new Set(['sf'] as const));
const sf = { gateway: new MockSfGateway(0), policy: new EntityPolicy() };

async function run(ctx: SapCallContext, name: string, args: Record<string, unknown> = {}): Promise<ToolResultPayload> {
  const result = await registry.get(name)!.run(args as never, { sap: ctx, gateway: new MockSapGateway(0), sf });
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
  it('names every tool after the sf domain and keeps them read-only', () => {
    const tools = [...registry.values()].filter((t) => t.domain === 'sf');
    expect(tools.map((t) => t.name).sort()).toEqual([
      'sf_getDirectReports',
      'sf_getEmployee',
      'sf_getJobHistory',
      'sf_getMyProfile',
      'sf_getReportingLine',
      'sf_listEntities',
      'sf_queryEntity',
      'sf_searchEmployees',
    ]);
    expect(tools.every((t) => t.risk === 'READ')).toBe(true);
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
    expect(r.components!.map((c) => c.type)).toEqual(['employee', 'business_object_table']);
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
