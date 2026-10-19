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

/** An employee as a line on a card. */
const person = (e: Employee) => ({
  userId: e.userId,
  displayName: e.displayName,
  ...(e.jobTitle && { jobTitle: e.jobTitle }),
  ...(e.department && { department: e.department }),
  ...(e.location && { location: e.location }),
});

const today = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** `2026-10-08` → `Oct 8` */
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** Upcoming absences shown on the time off card. */
const ABSENCE_HORIZON_DAYS = 120;

/**
 * A part of a card that SuccessFactors may not offer in every tenant (a module that is not
 * licensed, an entity the user may not read). The card is shown without it instead of failing.
 */
async function optional<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof SapError && err.code !== 'UNAVAILABLE') return undefined;
    throw err;
  }
}

/** A calendar date that exists. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Not a valid date');
/** Leave is requested at most this far back or ahead. */
const LEAVE_WINDOW_DAYS = 366;

const calendarDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

function checkLeaveDates(startDate: string, endDate: string) {
  if (endDate < startDate) throw new SapError('INVALID_INPUT', 'The last day off is before the first one.');
  if (Math.abs(calendarDays(today(), startDate)) > LEAVE_WINDOW_DAYS || calendarDays(startDate, endDate) > LEAVE_WINDOW_DAYS) {
    throw new SapError('INVALID_INPUT', 'Leave can be requested for dates within a year from today.');
  }
}

/** The name of a time type, for the confirmation; the code when SuccessFactors does not list it. */
async function timeTypeName(ctx: ToolContext, code: string) {
  const types = await ctx.sf.gateway.listTimeTypes(ctx.sap).catch(() => []);
  return types.find((t) => t.code === code)?.name ?? code;
}

const requestId = z.string().regex(/^\d{1,18}$/).describe('Id of the workflow request, from sf_listApprovals');
const comment = z.string().trim().max(500);

/** The pending request a decision is about. Refuses ids the caller has no pending request for. */
async function pendingRequest(ctx: ToolContext, id: string) {
  const request = (await ctx.sf.gateway.listPendingApprovals(ctx.sap)).find((r) => r.id === id);
  if (!request) throw new SapError('NOT_FOUND', `Request ${id} is not waiting for your decision.`);
  return request;
}

const requestLabel = (r: { title: string; subjectName?: string; detail?: string }) => `${r.title}${r.subjectName ? ` of ${r.subjectName}` : ''}${r.detail ? ` (${r.detail})` : ''}`;

/** The properties SuccessFactors named as unknown in a rejected read ("Invalid property names: Position/externalName"). */
function invalidProperties(err: unknown, entityName: string): string[] {
  if (!(err instanceof SapError) || err.code !== 'INVALID_INPUT') return [];
  const list = /Invalid property names?:\s*([^.]+)/i.exec(err.message)?.[1] ?? '';
  return list
    .split(',')
    .map((p) => p.trim().replace(new RegExp(`^${entityName}/`), ''))
    .filter((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p));
}

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
          { label: 'My team', prompt: 'Show my team overview.' },
          { label: 'My time off', prompt: 'Show my time off.' },
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
        followUps: hits.slice(0, 3).map((e) => ({ label: e.displayName, prompt: `Show employee ${e.userId}.` })),
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
        followUps: [
          { label: 'Team overview', prompt: userId ? `Show the team overview of employee ${managerId}.` : 'Show my team overview.' },
          ...team.slice(0, 2).map((e) => ({ label: e.displayName, prompt: `Show employee ${e.userId}.` })),
        ],
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
        components: [{ type: 'reporting_line', data: { employee: person(employee!), managers: managers.map(person) } }],
        source: source(ctx, 'ReportingLine', start),
        followUps: [
          ...(managers[0] ? [{ label: `Team of ${managers[0].displayName}`, prompt: `Show the team overview of employee ${managers[0].userId}.` }] : []),
          { label: 'Job history', prompt: userId ? `Show the job history of employee ${start}.` : 'Show my job history.' },
        ],
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
        followUps: [
          { label: 'Reporting line', prompt: userId ? `Show the reporting line of employee ${id}.` : 'Show my reporting line.' },
          { label: 'Time off', prompt: userId ? `Show the time off of employee ${id}.` : 'Show my time off.' },
        ],
      };
    },
  }),

  defineTool({
    name: 'sf_listEmployeeLocations',
    domain: 'sf',
    title: 'List employee locations',
    description: 'List every active employee the user may see with their work location. Feeds the employee map; too large for a model, so only the orchestrator calls it.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving employee locations',
    internal: true,
    input: {},
    async run(_args, ctx) {
      const employees = await ctx.sf.gateway.listEmployeePlaces(ctx.sap);
      return { data: { employees, summary: `${employees.length} employee(s).` }, source: source(ctx, 'Employee', 'all') };
    },
  }),

  defineTool({
    name: 'sf_showEmployeeMap',
    domain: 'sf',
    title: 'Show employees on a map',
    description:
      'Show the employees on a map in the chat, placed at their work location (the office, never a home address), optionally only those of one location. Use it when the user asks where employees work, or for a map of employees, people or offices.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Preparing the employee map',
    input: { location: z.string().trim().min(2).max(60).optional().describe('Work location or city as written in SuccessFactors, e.g. Riyadh') },
    async run({ location }, ctx) {
      const wanted = location?.toLowerCase();
      const employees = (await ctx.sf.gateway.listEmployeePlaces(ctx.sap)).filter((e) => !wanted || `${e.location ?? ''} ${e.city ?? ''}`.toLowerCase().includes(wanted));
      const byPlace = new Map<string, number>();
      for (const e of employees) {
        const place = e.location ?? e.city;
        if (place) byPlace.set(place, (byPlace.get(place) ?? 0) + 1);
      }
      const locations = [...byPlace].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ location: name, employees: count }));
      const withoutLocation = employees.filter((e) => !e.location && !e.city).length;
      return {
        data: {
          employees: employees.length,
          locations,
          withoutLocation,
          summary: employees.length
            ? `The map shows the ${employees.length} employee(s)${location ? ` at ${location}` : ''} by work location, across ${byPlace.size} location(s).` +
              `${withoutLocation ? ` ${withoutLocation} of them have no work location in SuccessFactors and are left off.` : ''}`
            : `No employees were found${location ? ` at ${location}` : ''}.`,
        },
        components: employees.length ? [{ type: 'employee_map', data: { title: location ? `Employees at ${location}` : 'All employees', employees: employees.length, ...(location && { location }) } }] : [],
        source: source(ctx, 'Employee', location || 'all'),
        followUps: location ? [{ label: 'All locations', prompt: 'Show the employees on a map.' }] : locations.slice(0, 3).map((l) => ({ label: `Only ${l.location}`, prompt: `Show the employees at ${l.location} on a map.` })),
      };
    },
  }),

  defineTool({
    name: 'sf_getTimeOff',
    domain: 'sf',
    title: 'Get time off',
    description: 'Retrieve the time off of an employee from SuccessFactors: what is left on each time account and the upcoming absences with their approval status. Without a user id: the current user.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving time off',
    input: { userId: optionalUserId },
    async run({ userId }, ctx) {
      const id = userId ?? (await ctx.sf.gateway.whoAmI(ctx.sap));
      const [employee, balances, absences] = await Promise.all([
        ctx.sf.gateway.getEmployee(ctx.sap, id),
        ctx.sf.gateway.getTimeOffBalances(ctx.sap, id),
        optional(ctx.sf.gateway.listAbsences(ctx.sap, [id], today(), daysFromToday(ABSENCE_HORIZON_DAYS))),
      ]);
      const upcoming = (absences ?? []).filter((a) => a.status !== 'CANCELLED' && a.status !== 'REJECTED').map(({ userId: _userId, ...a }) => a);
      const fmt = (b: (typeof balances)[number]) => `${b.balance} ${b.unit === 'HOURS' ? 'hours' : 'days'} of ${b.account}`;
      return {
        data: {
          employee: `${employee.displayName} (${employee.userId})`,
          balances,
          upcoming,
          summary: balances.length ? `**${employee.displayName}** has ${balances.map(fmt).join(' and ')} left.` : `No time account is on record for **${employee.displayName}**.`,
          ...(absences === undefined && { note: 'Upcoming absences could not be read.' }),
        },
        components: [{ type: 'time_off', data: { userId: employee.userId, displayName: employee.displayName, balances, upcoming: upcoming.slice(0, 20) } }],
        source: source(ctx, 'TimeOff', id),
        followUps: userId
          ? [{ label: 'Team overview', prompt: 'Show my team overview.' }]
          : [
              { label: 'Request leave', prompt: 'I want to request leave.' },
              { label: 'Leave types', prompt: 'Which kinds of leave can I request?' },
            ],
      };
    },
  }),

  defineTool({
    name: 'sf_listTimeTypes',
    domain: 'sf',
    title: 'List time types',
    description: 'List the kinds of time off in SuccessFactors (annual leave, sick leave, …) with the code sf_requestTimeOff needs. Call it when the user names a kind of leave whose code you do not know.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Reading the time types',
    input: {},
    async run(_args, ctx) {
      const types = await ctx.sf.gateway.listTimeTypes(ctx.sap);
      return {
        data: { timeTypes: types, summary: `${types.length} time type(s).` },
        components: types.length
          ? [{ type: 'business_object_table', data: { title: 'Time types', columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }], rows: types.slice(0, 200).map((t) => ({ code: t.code, name: t.name })) } }]
          : [],
        source: source(ctx, 'TimeType', 'all'),
        followUps: types.slice(0, 2).map((t) => ({ label: `Request ${t.name}`, prompt: `I want to request ${t.name.toLowerCase()}.` })),
      };
    },
  }),

  defineTool({
    name: 'sf_requestTimeOff',
    domain: 'sf',
    title: 'Request time off',
    description:
      'Create a leave request for the current user in SuccessFactors, from a start date to an end date (both included). Needs the time type code (see sf_listTimeTypes). SuccessFactors then sends it through its approval workflow.',
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Requesting time off',
    input: {
      timeType: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,60}$/).describe('Time type code, e.g. ANNUAL; from sf_listTimeTypes'),
      startDate: isoDate.describe('First day off, YYYY-MM-DD'),
      endDate: isoDate.describe('Last day off, YYYY-MM-DD'),
      comment: z.string().trim().max(255).optional().describe('Optional note for the approver'),
    },
    async preview({ timeType, startDate, endDate, comment }, ctx) {
      checkLeaveDates(startDate, endDate);
      const name = await timeTypeName(ctx, timeType);
      return {
        action: 'Request time off',
        businessObject: { type: 'EmployeeTime', id: `${startDate} – ${endDate}` },
        proposedChange: `${name} from ${startDate} to ${endDate} (${calendarDays(startDate, endDate)} calendar day(s))${comment ? `. Note: ${comment}` : ''}.`,
        impact: 'SuccessFactors creates the request for you and sends it to your approver if this time type needs approval. Your balance changes once it is approved.',
      };
    },
    async run({ timeType, startDate, endDate, comment }, ctx) {
      checkLeaveDates(startDate, endDate);
      const userId = await ctx.sf.gateway.whoAmI(ctx.sap);
      const [name, created] = await Promise.all([timeTypeName(ctx, timeType), ctx.sf.gateway.requestTimeOff(ctx.sap, { userId, timeType, startDate, endDate, ...(comment && { comment }) })]);
      return {
        data: { requestId: created.id, summary: `${name} from ${startDate} to ${endDate} was requested in SuccessFactors.` },
        source: source(ctx, 'EmployeeTime', created.id),
        followUps: [{ label: 'My time off', prompt: 'Show my time off.' }],
        outputs: { absence: created.id },
      };
    },
  }),

  defineTool({
    name: 'sf_getTeamOverview',
    domain: 'sf',
    title: 'Get team overview',
    description:
      'Summarize the team of a manager from SuccessFactors: headcount, who is out today, open positions and the people with their roles. Prefer this over sf_getDirectReports when a manager asks about their team. Without a user id: the team of the current user.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving the team',
    input: { userId: optionalUserId },
    async run({ userId }, ctx) {
      const managerId = userId ?? (await ctx.sf.gateway.whoAmI(ctx.sap));
      const [manager, team] = await Promise.all([ctx.sf.gateway.getEmployee(ctx.sap, managerId), ctx.sf.gateway.listDirectReports(ctx.sap, managerId)]);
      const [absences, positions] = await Promise.all([
        optional(ctx.sf.gateway.listAbsences(ctx.sap, team.map((e) => e.userId), today(), today())),
        optional(ctx.sf.gateway.listOpenPositions(ctx.sap, managerId)),
      ]);
      const out = new Map((absences ?? []).filter((a) => a.status === 'APPROVED').map((a) => [a.userId, a]));
      const outNames = team.filter((e) => out.has(e.userId)).map((e) => e.displayName);
      return {
        data: {
          manager: `${manager.displayName} (${manager.userId})`,
          headcount: team.length,
          ...(absences && { outToday: outNames }),
          ...(positions && { openPositions: positions }),
          team: team.map(facts),
          summary:
            `**${manager.displayName}** has ${team.length} direct report(s)` +
            `${absences ? `, ${outNames.length ? `${outNames.join(', ')} out today` : 'nobody out today'}` : ''}` +
            `${positions ? `, ${positions.length} open position(s)` : ''}.`,
        },
        components: [
          {
            type: 'team_overview',
            data: {
              managerId: manager.userId,
              managerName: manager.displayName,
              headcount: team.length,
              ...(absences && { outToday: outNames.length }),
              ...(positions && { openRoles: positions.length }),
              members: team.slice(0, 200).map((e) => ({ ...person(e), ...(out.has(e.userId) && { note: `Out until ${shortDate(out.get(e.userId)!.endDate)}`, noteTone: 'warning' as const }) })),
              ...(positions?.length && { openPositions: positions.slice(0, 20).map((p) => ({ code: p.code, ...(p.title && { title: p.title }), ...(p.location && { location: p.location }) })) }),
            },
          },
        ],
        source: source(ctx, 'Team', managerId),
        followUps: [
          { label: 'My approvals', prompt: 'What is waiting for my approval?' },
          ...team.filter((e) => out.has(e.userId)).slice(0, 1).map((e) => ({ label: `Time off of ${e.displayName}`, prompt: `Show the time off of employee ${e.userId}.` })),
          { label: 'Team on a map', prompt: 'Show the employees on a map.' },
        ],
      };
    },
  }),

  defineTool({
    name: 'sf_listApprovals',
    domain: 'sf',
    title: 'List my approvals',
    description: 'List the SuccessFactors workflow requests waiting for the decision of the current user: time off, job changes and other requests. Returns the request ids for sf_approveRequest and sf_declineRequest.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Retrieving your approvals',
    input: {},
    async run(_args, ctx) {
      const requests = await ctx.sf.gateway.listPendingApprovals(ctx.sap);
      return {
        data: {
          requests,
          summary: requests.length ? `${requests.length} request(s) are waiting for your decision.` : 'No request is waiting for your decision.',
        },
        components: requests.length
          ? [
              {
                type: 'approvals',
                data: {
                  items: requests.slice(0, 50).map((r) => ({
                    id: r.id,
                    title: r.title.slice(0, 120),
                    ...(r.subjectName && { subjectName: r.subjectName }),
                    ...(r.detail && { detail: r.detail.slice(0, 300) }),
                    ...(r.requestedOn && { requestedOn: r.requestedOn }),
                  })),
                },
              },
            ]
          : [],
        source: source(ctx, 'Approvals', 'pending'),
        followUps: requests.length
          ? requests.slice(0, 2).map((r) => ({ label: `Approve ${r.subjectName ?? r.title} (${r.id})`, prompt: `Approve request ${r.id}.` }))
          : [{ label: 'My team', prompt: 'Show my team overview.' }],
      };
    },
  }),

  defineTool({
    name: 'sf_approveRequest',
    domain: 'sf',
    title: 'Approve request',
    description: 'Approve a SuccessFactors workflow request that is waiting for the decision of the current user. Use the request id from sf_listApprovals.',
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Approving the request',
    input: { requestId, comment: comment.optional().describe('Optional comment for the requester') },
    async preview({ requestId }, ctx) {
      const r = await pendingRequest(ctx, requestId);
      return {
        action: 'Approve request',
        businessObject: { type: 'WorkflowRequest', id: requestId },
        proposedChange: `Approve: ${requestLabel(r)}.`,
        impact: 'SuccessFactors records your approval and moves the request to its next step, or completes it. An approval cannot be taken back here.',
      };
    },
    async run({ requestId, comment }, ctx) {
      const r = await pendingRequest(ctx, requestId);
      await ctx.sf.gateway.decideApproval(ctx.sap, requestId, 'APPROVE', comment);
      return {
        data: { requestId, decision: 'APPROVED', summary: `Approved: ${requestLabel(r)}.` },
        source: source(ctx, 'WorkflowRequest', requestId),
        followUps: [{ label: 'My approvals', prompt: 'What is waiting for my approval?' }],
        outputs: { requestId, decision: 'APPROVED' },
      };
    },
  }),

  defineTool({
    name: 'sf_declineRequest',
    domain: 'sf',
    title: 'Decline request',
    description: 'Decline (reject) a SuccessFactors workflow request that is waiting for the decision of the current user. A reason is required. Use the request id from sf_listApprovals.',
    risk: 'BUSINESS_WRITE',
    operation: 'SAP_WRITE',
    statusLabel: 'Declining the request',
    input: { requestId, comment: comment.min(3).describe('Reason for declining, shown to the requester') },
    async preview({ requestId, comment }, ctx) {
      const r = await pendingRequest(ctx, requestId);
      return {
        action: 'Decline request',
        businessObject: { type: 'WorkflowRequest', id: requestId },
        proposedChange: `Decline: ${requestLabel(r)}. Reason: ${comment}`,
        impact: 'SuccessFactors rejects the request and tells the requester your reason. A declined request cannot be reopened here.',
      };
    },
    async run({ requestId, comment }, ctx) {
      const r = await pendingRequest(ctx, requestId);
      await ctx.sf.gateway.decideApproval(ctx.sap, requestId, 'DECLINE', comment);
      return {
        data: { requestId, decision: 'DECLINED', summary: `Declined: ${requestLabel(r)}.` },
        source: source(ctx, 'WorkflowRequest', requestId),
        followUps: [{ label: 'My approvals', prompt: 'What is waiting for my approval?' }],
        outputs: { requestId, decision: 'DECLINED' },
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
      const read = (fields: string[]) => ctx.sf.gateway.queryEntity(ctx.sap, { entityName, select: fields, ...(filter && { filter }), ...(orderBy && { orderBy }), top: limit });
      // A tenant can lack a field of the allow-list. SuccessFactors names it, so the read is repeated
      // once without it rather than failing, as long as the filter and the sort order do not need it.
      let fields = select;
      let missing: string[] = [];
      const { records, hasMore } = await read(fields).catch((err: unknown) => {
        missing = invalidProperties(err, entityName);
        const needed = [...(filter ? filterFields(filter) : []), ...(orderBy ?? []).map((o) => o.field)];
        fields = select.filter((f) => !missing.includes(f));
        if (!missing.length || !fields.length || needed.some((f) => missing.includes(f))) throw err;
        return read(fields);
      });
      select = fields;
      const rows = records.map((r) => ctx.sf.policy.redact(entity, r));
      return {
        data: {
          entity: entityName,
          records: rows,
          hasMore,
          ...(missing.length && { missingFields: missing }),
          summary:
            `${rows.length} ${entityName} record(s)${hasMore ? `, more exist beyond the first ${limit}` : ''}.` +
            `${missing.length ? ` ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist in this tenant and ${missing.length === 1 ? 'was' : 'were'} left out.` : ''}`,
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
