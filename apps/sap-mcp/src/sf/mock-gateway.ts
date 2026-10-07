import { SapError, type SapCallContext } from '../sap/model.js';
import type { Employee, EntityQueryResult, JobHistoryEntry, SfGateway } from './model.js';
import type { EntityQuery, QueryFilter } from './query-builder.js';

/**
 * Mock SuccessFactors for local development and CI. All people are fictitious.
 * The development identities of the orchestrator are employees here, so "my
 * profile" and "my team" work for each of them.
 *
 * Role-based permissions are simulated the way SuccessFactors applies them:
 * everyone sees the directory, job history only for oneself and one's own
 * reporting line, and HR sees everyone.
 */

interface MockEmployee extends Employee {
  username: string;
  hr?: boolean;
}

const person = (userId: string, displayName: string, jobTitle: string, department: string, division: string, location: string, managerId: string | undefined, hireDate: string, extra: Partial<MockEmployee> = {}): MockEmployee => {
  const username = displayName.toLowerCase().replace(' ', '.');
  return { userId, displayName, username, email: `${username}@prowess.example`, jobTitle, department, division, location, ...(managerId && { managerId }), hireDate, status: 'ACTIVE', ...extra };
};

const EMPLOYEES: MockEmployee[] = [
  person('100001', 'Dana Whitfield', 'Chief Executive Officer', 'Executive Office', 'Corporate', 'Riyadh', undefined, '2015-03-01'),
  person('100010', 'Priya Nair', 'Chief Financial Officer', 'Finance', 'Corporate', 'Riyadh', '100001', '2017-06-12'),
  person('100020', 'Sam Rivera', 'HR Director', 'Human Resources', 'Corporate', 'Riyadh', '100001', '2018-01-15', { hr: true }),
  person('100101', 'Alex Morgan', 'Accounts Payable Manager', 'Accounts Payable', 'Finance', 'Riyadh', '100010', '2019-09-02'),
  person('100102', 'Jordan Lee', 'Accounts Payable Accountant', 'Accounts Payable', 'Finance', 'Jeddah', '100101', '2022-04-18'),
  person('100103', 'Mei Tanaka', 'Senior Accounts Payable Accountant', 'Accounts Payable', 'Finance', 'Riyadh', '100101', '2020-11-09'),
  person('100104', 'Luis Ortega', 'Payment Specialist', 'Accounts Payable', 'Finance', 'Riyadh', '100101', '2023-02-06'),
  person('100110', 'Casey Kim', 'Internal Auditor', 'Internal Audit', 'Finance', 'Riyadh', '100010', '2021-08-23'),
  person('100201', 'Omar Haddad', 'HR Business Partner', 'Human Resources', 'Corporate', 'Jeddah', '100020', '2021-05-03', { hr: true }),
  person('100202', 'Hannah Schmidt', 'Talent Acquisition Lead', 'Human Resources', 'Corporate', 'Riyadh', '100020', '2019-01-07', { status: 'INACTIVE' }),
];

const job = (userId: string, startDate: string, endDate: string | undefined, jobTitle: string, department: string, location: string, managerId: string, event: string, eventReason: string) => ({
  userId,
  startDate,
  ...(endDate && { endDate }),
  jobTitle,
  department,
  division: 'Finance',
  location,
  company: '1030',
  managerId,
  event,
  eventReason,
});

const JOBS: (JobHistoryEntry & { userId: string })[] = [
  job('100101', '2023-01-01', undefined, 'Accounts Payable Manager', 'Accounts Payable', 'Riyadh', '100010', 'Promotion', 'Promotion to manager'),
  job('100101', '2019-09-02', '2022-12-31', 'Senior Accounts Payable Accountant', 'Accounts Payable', 'Riyadh', '100010', 'Hire', 'New hire'),
  job('100102', '2024-07-01', undefined, 'Accounts Payable Accountant', 'Accounts Payable', 'Jeddah', '100101', 'Transfer', 'Location change'),
  job('100102', '2022-04-18', '2024-06-30', 'Accounts Payable Accountant', 'Accounts Payable', 'Riyadh', '100101', 'Hire', 'New hire'),
  job('100103', '2020-11-09', undefined, 'Senior Accounts Payable Accountant', 'Accounts Payable', 'Riyadh', '100101', 'Hire', 'New hire'),
  job('100104', '2023-02-06', undefined, 'Payment Specialist', 'Accounts Payable', 'Riyadh', '100101', 'Hire', 'New hire'),
  job('100110', '2021-08-23', undefined, 'Internal Auditor', 'Internal Audit', 'Riyadh', '100010', 'Hire', 'New hire'),
];

const DEPARTMENTS = ['Executive Office', 'Finance', 'Accounts Payable', 'Internal Audit', 'Human Resources'].map((name, i) => ({
  externalCode: `D${String(i + 1).padStart(3, '0')}`,
  startDate: '2015-01-01',
  endDate: null,
  name,
  description: name,
  parent: null,
  headOfUnit: null,
  status: 'A',
}));

function matches(record: Record<string, unknown>, filter: QueryFilter): boolean {
  if ('and' in filter) return filter.and.every((f) => matches(record, f));
  if ('or' in filter) return filter.or.some((f) => matches(record, f));
  const actual = record[filter.field];
  if (actual == null) return filter.operator === 'ne';
  const a = typeof actual === 'number' ? actual : String(actual).toLowerCase();
  const b = typeof filter.value === 'number' && typeof a === 'number' ? filter.value : String(filter.value).toLowerCase();
  switch (filter.operator) {
    case 'eq':
      return a === b;
    case 'ne':
      return a !== b;
    case 'gt':
      return a > b;
    case 'ge':
      return a >= b;
    case 'lt':
      return a < b;
    case 'le':
      return a <= b;
    case 'contains':
      return String(a).includes(String(b));
    case 'startswith':
      return String(a).startsWith(String(b));
    case 'endswith':
      return String(a).endsWith(String(b));
  }
}

export class MockSfGateway implements SfGateway {
  readonly systemId = 'SF-MOCK';
  readonly mock = true;

  constructor(private readonly latencyMs = 150) {}

  private async latency() {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs * (0.6 + Math.random() * 0.8)));
  }

  private caller(ctx: SapCallContext): MockEmployee {
    const me = EMPLOYEES.find((e) => e.email === ctx.principal.sub);
    if (!me) throw new SapError('NOT_FOUND', 'No SuccessFactors user is linked to your login.');
    return me;
  }

  private find(userId: string): MockEmployee {
    const hit = EMPLOYEES.find((e) => e.userId === userId);
    if (!hit) throw new SapError('NOT_FOUND', `Employee ${userId} was not found in SuccessFactors.`);
    return hit;
  }

  private reportsTo(userId: string, managerId: string): boolean {
    for (let current = this.find(userId).managerId, depth = 0; current && depth < 10; current = this.find(current).managerId, depth++) {
      if (current === managerId) return true;
    }
    return false;
  }

  /** Detailed employment data: oneself, one's reporting line downwards, or anyone for HR. */
  private maySeeDetails(ctx: SapCallContext, userId: string): boolean {
    const me = this.caller(ctx);
    return me.hr === true || me.userId === userId || this.reportsTo(userId, me.userId);
  }

  private toEmployee(e: MockEmployee): Employee {
    const { username: _username, hr: _hr, ...employee } = e;
    const manager = e.managerId ? EMPLOYEES.find((m) => m.userId === e.managerId) : undefined;
    return { ...employee, ...(manager && { managerName: manager.displayName }) };
  }

  async whoAmI(ctx: SapCallContext): Promise<string> {
    await this.latency();
    return this.caller(ctx).userId;
  }

  async getEmployee(ctx: SapCallContext, userId: string): Promise<Employee> {
    await this.latency();
    this.caller(ctx);
    return this.toEmployee(this.find(userId));
  }

  async listDirectReports(ctx: SapCallContext, managerId: string): Promise<Employee[]> {
    await this.latency();
    this.caller(ctx);
    this.find(managerId);
    return EMPLOYEES.filter((e) => e.managerId === managerId && e.status === 'ACTIVE').map((e) => this.toEmployee(e));
  }

  async searchEmployees(ctx: SapCallContext, query: string): Promise<Employee[]> {
    await this.latency();
    this.caller(ctx);
    const q = query.toLowerCase();
    return EMPLOYEES.filter((e) => e.status === 'ACTIVE' && (e.displayName.toLowerCase().includes(q) || e.username.includes(q))).map((e) => this.toEmployee(e));
  }

  async getJobHistory(ctx: SapCallContext, userId: string): Promise<JobHistoryEntry[]> {
    await this.latency();
    const employee = this.find(userId);
    if (!this.maySeeDetails(ctx, userId)) {
      throw new SapError('NOT_AUTHORIZED', `SuccessFactors denied access: your role-based permissions do not include the job history of ${employee.displayName}.`);
    }
    return JOBS.filter((j) => j.userId === userId).map(({ userId: _userId, ...entry }) => entry);
  }

  async queryEntity(ctx: SapCallContext, query: EntityQuery): Promise<EntityQueryResult> {
    await this.latency();
    this.caller(ctx);
    // SuccessFactors leaves out the records a user may not see; it does not report an error.
    const tables: Record<string, Record<string, unknown>[]> = {
      User: EMPLOYEES.map((e) => ({ ...e, title: e.jobTitle, firstName: e.displayName.split(' ')[0], lastName: e.displayName.split(' ')[1], status: e.status === 'ACTIVE' ? 't' : 'f' })),
      EmpJob: JOBS.filter((j) => this.maySeeDetails(ctx, j.userId)).map((j, i) => ({ ...j, seqNumber: 1, emplStatus: 'A', position: `P${1000 + i}` })),
      FODepartment: DEPARTMENTS,
    };
    let rows = (tables[query.entityName] ?? []).filter((r) => !query.filter || matches(r, query.filter));
    for (const order of [...(query.orderBy ?? [])].reverse()) {
      const sign = order.direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => sign * String(a[order.field] ?? '').localeCompare(String(b[order.field] ?? ''), 'en', { numeric: true }));
    }
    return {
      records: rows.slice(0, query.top).map((r) => Object.fromEntries(query.select.map((field) => [field, (r[field] as unknown) ?? null]))),
      hasMore: rows.length > query.top,
    };
  }
}
