import { UIComponentSchema } from '@prowess/contracts';
import { describe, expect, it } from 'vitest';
import { MockMailGateway } from '../src/outlook/mock-gateway.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import type { SapCallContext } from '../src/sap/model.js';
import { BUSINESS_CASES, CASE_ENTITIES, CASE_MODULES, isProtectedField } from '../src/sf/business-cases.js';
import { MockSfGateway } from '../src/sf/mock-gateway.js';
import { EntityPolicy } from '../src/sf/policy.js';
import { buildRegistry } from '../src/tools/registry.js';
import type { ToolResultPayload } from '../src/tools/types.js';

const outlook = { gateway: new MockMailGateway(0), allowedRecipientDomains: [] as string[] };

const as = (sub: string) => ({ principal: { sub, roles: ['AI_USER', 'AI_HR_USER', 'AI_POWER_USER'] }, correlationId: 't' }) as unknown as SapCallContext;
const alex = as('alex.morgan@prowess.example'); // manager of Jordan, Mei and Luis
const jordan = as('jordan.lee@prowess.example');
const sam = as('sam.rivera@prowess.example'); // HR
const registry = buildRegistry(new Set(['sf'] as const));
const sf = { gateway: new MockSfGateway(0), policy: new EntityPolicy() };

async function run(ctx: SapCallContext, name: string, args: Record<string, unknown> = {}): Promise<ToolResultPayload> {
  const result = await registry.get(name)!.run(args as never, { sap: ctx, gateway: new MockSapGateway(0), sf, outlook });
  for (const c of result.components ?? []) expect(UIComponentSchema.safeParse(c).error?.issues, `${name} component ${c.type}`).toBeUndefined();
  return result;
}
const table = (r: ToolResultPayload) => r.components![0]!.data as { title: string; columns: { key: string }[]; rows: Record<string, unknown>[] };

describe('business case catalog', () => {
  it('holds the top cases of all thirteen modules with unique ids', () => {
    expect(new Set(BUSINESS_CASES.map((c) => c.id)).size).toBe(BUSINESS_CASES.length);
    const perModule = CASE_MODULES.map((m) => BUSINESS_CASES.filter((c) => c.module === m).length);
    // Five per module where the library has that many, plus the inbox of an employee under Common Entities.
    expect(perModule).toEqual([5, 6, 5, 5, 5, 5, 5, 5, 5, 5, 3, 4, 1]);
    expect(BUSINESS_CASES).toHaveLength(59);
  });

  it('reads one entity per case through safe names, and marks Learning as out of reach', () => {
    for (const c of BUSINESS_CASES) {
      for (const name of [c.input?.field, c.orderBy?.field, ...(c.select ?? []), ...(c.columns ?? [])]) {
        if (name) expect(name, c.id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/);
      }
      if (!c.unavailable) expect(c.entity, c.id).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
    expect(BUSINESS_CASES.filter((c) => c.unavailable).map((c) => c.module)).toEqual(Array(5).fill('Learning'));
    expect(CASE_ENTITIES.has('EmpJob')).toBe(true);
    expect(CASE_ENTITIES.has('catalog-service')).toBe(false);
  });

  it('never shows identity documents, bank details or special categories of personal data', () => {
    for (const name of ['nationalId', 'ssn', 'bankAccountNumber', 'iban', 'dateOfBirth', 'gender', 'maritalStatus', 'passwordHash']) expect(isProtectedField(name), name).toBe(true);
    for (const name of ['userId', 'jobTitle', 'paycompvalue', 'startDate', 'department']) expect(isProtectedField(name), name).toBe(false);
    // No case asks for a protected field itself.
    expect(BUSINESS_CASES.flatMap((c) => [...(c.columns ?? []), ...(c.select ?? []), c.input?.field ?? '']).filter(isProtectedField)).toEqual([]);
  });
});

describe('business case tools', () => {
  it('are offered to power users only', () => {
    const gated = [...registry.values()].filter((t) => t.requiredRole).map((t) => `${t.name}:${t.requiredRole}:${t.risk}`);
    expect(gated.sort()).toEqual(['sf_describeEntity:AI_POWER_USER:READ', 'sf_listBusinessCases:AI_POWER_USER:READ', 'sf_runBusinessCase:AI_POWER_USER:READ']);
  });

  it('lists the cases, all of them or one module', async () => {
    const all = await run(alex, 'sf_listBusinessCases');
    expect(all.data.summary).toBe('59 business case(s) across 13 modules.');
    expect(table(all).rows).toHaveLength(59);
    const recruiting = await run(alex, 'sf_listBusinessCases', { module: 'Recruiting' });
    expect(table(recruiting).rows.map((r) => r.id)).toEqual(['rcm-01', 'rcm-02', 'rcm-03', 'rcm-04', 'rcm-05']);
    expect(table(recruiting).rows[1]).toMatchObject({ title: 'Postings of a requisition', needs: 'Job requisition id' });
    expect(table(await run(alex, 'sf_listBusinessCases', { module: 'Learning' })).rows[0]!.needs).toBe('Not available here');
  });

  it('runs a case for the caller when no value is given, with its own columns first', async () => {
    const r = await run(jordan, 'sf_runBusinessCase', { caseId: 'EC-01' });
    expect(r.data.summary).toBe('Current job information: 2 record(s). 5 further field(s) are left out of the table.');
    expect(table(r).columns).toHaveLength(10);
    expect(table(r).columns.map((c) => c.key).slice(0, 4)).toEqual(['userId', 'startDate', 'jobTitle', 'position']);
    expect(table(r).rows.map((row) => row.startDate)).toEqual(['2024-07-01', '2022-04-18']);
    expect(r.source).toMatchObject({ system: 'SF-MOCK', objectType: 'EmpJob', mock: true });
  });

  it('runs a case for a given value, and SuccessFactors permissions still limit the records', async () => {
    expect(table(await run(alex, 'sf_runBusinessCase', { caseId: 'ec-02' })).rows.map((r) => r.userId).sort()).toEqual(['100102', '100102', '100103', '100104']);
    // Jordan may not see his manager's job records: the mock returns none, as SuccessFactors would.
    expect((await run(jordan, 'sf_runBusinessCase', { caseId: 'ec-01', value: '100101' })).components).toEqual([]);
    expect(table(await run(sam, 'sf_runBusinessCase', { caseId: 'rcm-01' })).rows).toHaveLength(2);
    expect(table(await run(sam, 'sf_runBusinessCase', { caseId: 'ce-02', top: 2 })).rows).toHaveLength(2);
  });

  it('hides protected fields whatever the tenant returns, and refuses them as a filter', async () => {
    const r = await run(sam, 'sf_runBusinessCase', { caseId: 'ec-04', value: '100102' });
    expect(table(r).columns.map((c) => c.key)).toEqual(['userId', 'payComponent', 'paycompvalue', 'currencyCode', 'frequency', 'startDate']);
    expect(r.data.protectedFields).toEqual(['bankAccountNumber']);
    expect(JSON.stringify(r)).not.toContain('SA00');
    expect(r.data.summary).toMatch(/1 protected field\(s\) are not shown\.$/);
    await expect(run(sam, 'sf_runBusinessCase', { caseId: 'ec-04', filters: [{ field: 'bankAccountNumber', operator: 'startswith', value: 'SA' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('validates the value a case needs', async () => {
    await expect(run(alex, 'sf_runBusinessCase', { caseId: 'rcm-02' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Postings of a requisition needs a value: Job requisition id.' });
    await expect(run(alex, 'sf_runBusinessCase', { caseId: 'rcm-02', value: "1 or 1 eq 1" })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Job requisition id must be a number.' });
    await expect(run(alex, 'sf_runBusinessCase', { caseId: 'ec-03', value: 'yesterday' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run(alex, 'sf_runBusinessCase', { caseId: 'zz-99' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run(alex, 'sf_runBusinessCase', { caseId: 'lms-01' })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('explains a module the tenant does not have, and a filter field the tenant names differently', async () => {
    await expect(run(sam, 'sf_runBusinessCase', { caseId: 'cal-01' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('this SuccessFactors tenant has no CalibrationSession') });
    // The mock JobRequisition has no field "status": the rejection points to the way out.
    const rejected = run(sam, 'sf_runBusinessCase', { caseId: 'rcm-01', filters: [{ field: 'status', operator: 'eq', value: 'Open' }] });
    await expect(rejected).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/Invalid property names: JobRequisition\/status\. Look up the fields of JobRequisition with sf_describeEntity/) });
    expect(table(await run(sam, 'sf_runBusinessCase', { caseId: 'rcm-01', filters: [{ field: 'internalStatus', operator: 'eq', value: 'Open' }] })).rows).toHaveLength(2);
  });

  it('describes the entities of the cases, and no others', async () => {
    const r = await run(sam, 'sf_describeEntity', { entityName: 'EmpPayCompRecurring' });
    expect(r.data.summary).toBe('EmpPayCompRecurring has 7 field(s) in this tenant.');
    expect(table(r).rows.find((row) => row.name === 'userId')).toMatchObject({ type: 'String', notes: 'key' });
    expect(table(r).rows.find((row) => row.name === 'bankAccountNumber')).toMatchObject({ notes: 'protected, never shown' });
    await expect(run(sam, 'sf_describeEntity', { entityName: 'PerNationalId' })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    // An entity of the generic query's allow-list can be described as well.
    expect((await run(sam, 'sf_describeEntity', { entityName: 'FODepartment' })).data.entity).toBe('FODepartment');
  });
});
