import { z } from 'zod';
import { SapError } from '../sap/model.js';
import type { Employee } from '../sf/model.js';
import { MAX_TOP } from '../sf/policy.js';
import { FILTER_OPERATORS, filterFields, type QueryFilter } from '../sf/query-builder.js';
import { defineTool, now, type ToolContext } from './types.js';

/** A SuccessFactors user id. The charset also keeps it safe as an OData key. */
const userId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._@-]{1,100}$/)
  .describe('SuccessFactors user id of the employee, e.g. 100102');
const optionalUserId = userId.optional().describe('SuccessFactors user id of the employee. Leave out for the current user.');
/** A plain field name. Navigation paths are not offered by the generic query. */
const field = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,59}$/);

const REPORTING_LINE_DEPTH = 8;
const TABLE_COLUMNS = 12;

const source = (ctx: ToolContext, objectType: string, objectId: string) => ({ system: ctx.sf.gateway.systemId, objectType, objectId: objectId.slice(0, 80), retrievedAt: now(), mock: ctx.sf.gateway.mock });

/** What the model learns about an employee. The e-mail address stays on the card. */
const facts = ({ email: _email, ...rest }: Employee) => rest;

const describe = (e: Employee) =>
  `**${e.displayName}** (${e.userId})${e.jobTitle ? `, ${e.jobTitle}` : ''}${e.department ? ` in ${e.department}` : ''}${e.location ? `, ${e.location}` : ''}` +
  `${e.managerName ? `. Reports to ${e.managerName}` : ''}.${e.status === 'INACTIVE' ? ' Inactive.' : ''}`;

const employeeFollowUps = (e: Employee) => [
  { label: 'Reporting line', prompt: `Show the reporting line of employee ${e.userId}.` },
  { label: 'Direct reports', prompt: `Who reports to employee ${e.userId}?` },
];

const employeeTable = (title: string, employees: Employee[]) => ({
  type: 'business_object_table' as const,
  data: {
    title,
    columns: [
      { key: 'userId', label: 'User ID' },
      { key: 'name', label: 'Name' },
      { key: 'jobTitle', label: 'Job title' },
      { key: 'department', label: 'Department' },
      { key: 'location', label: 'Location' },
    ],
    rows: employees.slice(0, 200).map((e) => ({ userId: e.userId, name: e.displayName, jobTitle: e.jobTitle ?? null, department: e.department ?? null, location: e.location ?? null })),
  },
});

const cell = (v: unknown): string | number | null => (v == null ? null : typeof v === 'number' ? v : String(v).slice(0, 300));

export const sfTools = [
  defineTool({
    name: 'sf_getMyProfile',
    domain: 'sf',
    title: 'Get my profile',
    description: 'Retrieve the SuccessFactors employee profile of the current user: job title, department, location and manager.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving your profile',
    input: {},
    async run(_args, ctx) {
      const e = await ctx.sf.gateway.getEmployee(ctx.sap, await ctx.sf.gateway.whoAmI(ctx.sap));
      return {
        data: { employee: facts(e), summary: `You are ${describe(e)}` },
        components: [{ type: 'employee', data: e }],
        source: source(ctx, 'Employee', e.userId),
        followUps: [
          { label: 'My team', prompt: 'Who are my direct reports?' },
          { label: 'My job history', prompt: 'Show my job history.' },
        ],
      };
    },
  }),

  defineTool({
    name: 'sf_getEmployee',
    domain: 'sf',
    title: 'Get employee',
    description: 'Retrieve the SuccessFactors profile of one employee by user id: job title, department, location and manager.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving employee',
    input: { userId },
    async run({ userId }, ctx) {
      const e = await ctx.sf.gateway.getEmployee(ctx.sap, userId);
      return {
        data: { employee: facts(e), summary: describe(e) },
        components: [{ type: 'employee', data: e }],
        source: source(ctx, 'Employee', e.userId),
        followUps: employeeFollowUps(e),
      };
    },
  }),

  defineTool({
    name: 'sf_searchEmployees',
    domain: 'sf',
    title: 'Search employees',
    description: 'Find employees in SuccessFactors by a part of their name. Returns user ids for the other employee tools.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Searching employees',
    input: { query: z.string().trim().min(2).max(60).describe('Part of a first name, last name or user name') },
    async run({ query }, ctx) {
      const hits = await ctx.sf.gateway.searchEmployees(ctx.sap, query);
      return {
        data: { employees: hits.map(facts), summary: hits.length ? `${hits.length} employee(s) match "${query}".` : `No employee matches "${query}".` },
        components: hits.length ? [employeeTable(`Employees matching "${query}"`, hits)] : [],
        source: source(ctx, 'EmployeeSearch', query),
      };
    },
  }),

  defineTool({
    name: 'sf_getDirectReports',
    domain: 'sf',
    title: 'Get direct reports',
    description: 'List the active employees who report directly to a manager in SuccessFactors. Without a user id: the team of the current user.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving the team',
    input: { userId: optionalUserId },
    async run({ userId }, ctx) {
      const managerId = userId ?? (await ctx.sf.gateway.whoAmI(ctx.sap));
      const [manager, team] = await Promise.all([ctx.sf.gateway.getEmployee(ctx.sap, managerId), ctx.sf.gateway.listDirectReports(ctx.sap, managerId)]);
      return {
        data: {
          manager: `${manager.displayName} (${manager.userId})`,
          directReports: team.map(facts),
          summary: team.length ? `**${manager.displayName}** has ${team.length} direct report(s).` : `**${manager.displayName}** has no direct reports.`,
        },
        components: team.length ? [employeeTable(`Direct reports · ${manager.displayName}`, team)] : [],
        source: source(ctx, 'Team', managerId),
      };
    },
  }),

  defineTool({
    name: 'sf_getReportingLine',
    domain: 'sf',
    title: 'Get reporting line',
    description: 'Show the chain of managers above an employee in SuccessFactors, up to the top. Without a user id: the reporting line of the current user.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving the reporting line',
    input: { userId: optionalUserId },
    async run({ userId }, ctx) {
      const start = userId ?? (await ctx.sf.gateway.whoAmI(ctx.sap));
      const line = [await ctx.sf.gateway.getEmployee(ctx.sap, start)];
      // A manager above the caller's permissions ends the line instead of failing it.
      while (line.length <= REPORTING_LINE_DEPTH) {
        const next = line.at(-1)!.managerId;
        if (!next || line.some((e) => e.userId === next)) break;
        const manager = await ctx.sf.gateway.getEmployee(ctx.sap, next).catch((err: unknown) => {
          if (err instanceof SapError && (err.code === 'NOT_AUTHORIZED' || err.code === 'NOT_FOUND')) return undefined;
          throw err;
        });
        if (!manager) break;
        line.push(manager);
      }
      const [employee, ...managers] = line;
      return {
        data: {
          employee: `${employee!.displayName} (${employee!.userId})`,
          managers: managers.map(facts),
          summary: managers.length
            ? `**${employee!.displayName}** reports to ${managers.map((m) => m.displayName).join(', who reports to ')}.`
            : `**${employee!.displayName}** has no manager on record.`,
        },
        components: [{ type: 'employee', data: employee! }, ...(managers.length ? [employeeTable(`Reporting line · ${employee!.displayName}`, managers)] : [])],
        source: source(ctx, 'ReportingLine', start),
      };
    },
  }),

  defineTool({
    name: 'sf_getJobHistory',
    domain: 'sf',
    title: 'Get job history',
    description:
      'Retrieve the job history of an employee from SuccessFactors Employee Central: position, department, location and the event behind each change. Without a user id: the history of the current user.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving job history',
    input: { userId: optionalUserId },
    async run({ userId }, ctx) {
      const id = userId ?? (await ctx.sf.gateway.whoAmI(ctx.sap));
      const [employee, history] = await Promise.all([ctx.sf.gateway.getEmployee(ctx.sap, id), ctx.sf.gateway.getJobHistory(ctx.sap, id)]);
      const title = (h: (typeof history)[number]) => [h.jobTitle, h.department].filter(Boolean).join(', ') || 'Job information';
      return {
        data: {
          employee: `${employee.displayName} (${employee.userId})`,
          history,
          summary: history.length ? `**${employee.displayName}** has ${history.length} job record(s) since ${history.at(-1)!.startDate}.` : `No job history is on record for **${employee.displayName}**.`,
        },
        components: history.length
          ? [
              {
                type: 'timeline',
                data: {
                  title: `Job history · ${employee.displayName}`,
                  events: history.map((h) => ({
                    date: h.startDate,
                    title: title(h),
                    detail: [h.event && `${h.event}${h.eventReason ? ` (${h.eventReason})` : ''}`, h.location, h.endDate ? `until ${h.endDate}` : 'current'].filter(Boolean).join(' · '),
                  })),
                },
              },
            ]
          : [],
        source: source(ctx, 'JobHistory', id),
      };
    },
  }),

  defineTool({
    name: 'sf_listEntities',
    domain: 'sf',
    title: 'List queryable entities',
    description: 'List the SuccessFactors entities and fields that sf_queryEntity may read. Call this before sf_queryEntity when the entity or its field names are not known.',
    risk: 'READ',
    operation: 'NONE',
    statusLabel: 'Reading the entity list',
    input: {},
    async run(_args, ctx) {
      const entities = ctx.sf.policy.list().filter((e) => e.operations.includes('read'));
      return {
        data: {
          entities: entities.map((e) => ({ entity: e.entityName, fields: e.fields, protectedFields: e.sensitiveFields })),
          summary: `${entities.length} SuccessFactors entities can be queried: ${entities.map((e) => e.entityName).join(', ')}.`,
        },
      };
    },
  }),

  defineTool({
    name: 'sf_queryEntity',
    domain: 'sf',
    title: 'Query an entity',
    description:
      'Read records of an allow-listed SuccessFactors OData entity (for example EmpJob, Position, FODepartment) when no other tool fits. Only listed entities and fields are accepted; ' +
      'all filters must hold. A query without a filter returns a small page. Protected fields come back redacted.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Querying SuccessFactors',
    input: {
      entityName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/).describe('Entity set name, e.g. EmpJob'),
      select: z.array(field).min(1).max(TABLE_COLUMNS).describe('Fields to return'),
      filters: z
        .array(z.object({ field, operator: z.enum(FILTER_OPERATORS), value: z.union([z.string().max(200), z.number(), z.boolean()]) }))
        .max(8)
        .optional()
        .describe('Conditions, combined with AND'),
      orderBy: z.array(z.object({ field, direction: z.enum(['asc', 'desc']) })).max(3).optional(),
      top: z.number().int().min(1).max(MAX_TOP).optional().describe('Maximum number of records'),
    },
    async run({ entityName, select, filters, orderBy, top }, ctx) {
      const filter: QueryFilter | undefined = filters?.length ? { and: filters } : undefined;
      const entity = ctx.sf.policy.assertReadable(entityName, select, [...(filter ? filterFields(filter) : []), ...(orderBy ?? []).map((o) => o.field)]);
      const limit = ctx.sf.policy.boundedTop(top, Boolean(filter));
      const { records, hasMore } = await ctx.sf.gateway.queryEntity(ctx.sap, { entityName, select, ...(filter && { filter }), ...(orderBy && { orderBy }), top: limit });
      const rows = records.map((r) => ctx.sf.policy.redact(entity, r));
      return {
        data: {
          entity: entityName,
          records: rows,
          hasMore,
          summary: `${rows.length} ${entityName} record(s)${hasMore ? `, more exist beyond the first ${limit}` : ''}.`,
        },
        components: rows.length
          ? [
              {
                type: 'business_object_table',
                data: {
                  title: `${entityName} · ${rows.length} record(s)`,
                  columns: select.map((key) => ({ key, label: key })),
                  rows: rows.map((r) => Object.fromEntries(select.map((key) => [key, cell(r[key])]))),
                },
              },
            ]
          : [],
        source: source(ctx, entityName, filters?.map((f) => `${f.field} ${f.operator} ${f.value}`).join(' and ') || 'all'),
      };
    },
  }),
];
