import { SapError, type SapCallContext } from '../sap/model.js';
import type { Absence, ApprovalRequest, Employee, EmployeePlace, EntityField, EntityQueryResult, EntityRead, NewTimeOff, TimeType, JobHistoryEntry, OpenPosition, SfGateway, TimeOffBalance } from './model.js';
import { filterFields, type EntityQuery, type QueryFilter } from './query-builder.js';

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

const OPEN_POSITIONS: (OpenPosition & { managerId: string })[] = [
  { managerId: '100101', code: 'P2041', title: 'Accounts Payable Accountant', department: 'Accounts Payable', location: 'Riyadh' },
  { managerId: '100020', code: 'P3007', title: 'Talent Acquisition Lead', department: 'Human Resources', location: 'Riyadh' },
];

const TIME_TYPES: TimeType[] = [
  { code: 'ANNUAL', name: 'Annual leave' },
  { code: 'SICK', name: 'Sick leave' },
  { code: 'UNPAID', name: 'Unpaid leave' },
];

interface MockApproval extends ApprovalRequest {
  approverId: string;
  /** The absence a leave request decides. */
  absence?: Absence;
}

/** A date `offset` days from today, as YYYY-MM-DD. */
const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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

  // Absences are dated from today, so "who is out" always has an answer. Decisions change them.
  private readonly absences: Absence[];
  private readonly approvals: MockApproval[];

  constructor(private readonly latencyMs = 150) {
    const pendingLeave: Absence = { userId: '100102', timeType: 'Annual leave', startDate: isoDay(12), endDate: isoDay(16), days: 5, status: 'PENDING' };
    this.absences = [
      { userId: '100102', timeType: 'Annual leave', startDate: isoDay(0), endDate: isoDay(1), days: 2, status: 'APPROVED' },
      pendingLeave,
      { userId: '100103', timeType: 'Annual leave', startDate: isoDay(20), endDate: isoDay(24), days: 5, status: 'APPROVED' },
      { userId: '100101', timeType: 'Annual leave', startDate: isoDay(30), endDate: isoDay(34), days: 5, status: 'APPROVED' },
    ];
    this.approvals = [
      {
        id: '4001',
        approverId: '100101',
        subjectUserId: '100102',
        subjectName: 'Jordan Lee',
        title: 'Annual leave',
        detail: `${pendingLeave.startDate} to ${pendingLeave.endDate}, 5 days`,
        requestedOn: isoDay(-2),
        absence: pendingLeave,
      },
      { id: '4002', approverId: '100101', subjectUserId: '100103', subjectName: 'Mei Tanaka', title: 'Job change', detail: 'Promotion to Accounts Payable Team Lead', requestedOn: isoDay(-1) },
    ];
  }

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

  async listEmployeePlaces(ctx: SapCallContext): Promise<EmployeePlace[]> {
    await this.latency();
    this.caller(ctx);
    return EMPLOYEES.filter((e) => e.status === 'ACTIVE').map((e) => ({
      userId: e.userId,
      displayName: e.displayName,
      ...(e.jobTitle && { jobTitle: e.jobTitle }),
      ...(e.department && { department: e.department }),
      ...(e.location && { location: e.location, city: e.location }),
      country: 'SA',
    }));
  }

  async getTimeOffBalances(ctx: SapCallContext, userId: string): Promise<TimeOffBalance[]> {
    await this.latency();
    const employee = this.find(userId);
    if (!this.maySeeDetails(ctx, userId)) {
      throw new SapError('NOT_AUTHORIZED', `SuccessFactors denied access: your role-based permissions do not include the time off of ${employee.displayName}.`);
    }
    // Deterministic per employee, so the same person always shows the same balance.
    const seed = Number(userId) % 7;
    return [
      { account: 'Annual leave', balance: 9.5 + seed * 2.5, unit: 'DAYS' },
      { account: 'Sick leave', balance: 10 - (seed % 4), unit: 'DAYS' },
    ];
  }

  async listAbsences(ctx: SapCallContext, userIds: string[], from: string, to: string): Promise<Absence[]> {
    await this.latency();
    this.caller(ctx);
    return this.absences
      .filter((a) => userIds.includes(a.userId) && this.maySeeDetails(ctx, a.userId) && a.startDate <= to && a.endDate >= from)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .map((a) => ({ ...a }));
  }

  async listOpenPositions(ctx: SapCallContext, managerId: string): Promise<OpenPosition[]> {
    await this.latency();
    this.caller(ctx);
    this.find(managerId);
    return OPEN_POSITIONS.filter((p) => p.managerId === managerId).map(({ managerId: _managerId, ...position }) => position);
  }

  async listTimeTypes(ctx: SapCallContext): Promise<TimeType[]> {
    await this.latency();
    this.caller(ctx);
    return TIME_TYPES.map((t) => ({ ...t }));
  }

  async requestTimeOff(ctx: SapCallContext, request: NewTimeOff): Promise<{ id: string }> {
    await this.latency();
    const me = this.caller(ctx);
    if (request.userId !== me.userId) throw new SapError('NOT_AUTHORIZED', 'SuccessFactors denied the request: you may request time off only for yourself.');
    const type = TIME_TYPES.find((t) => t.code === request.timeType);
    if (!type) throw new SapError('BUSINESS_RULE', `SuccessFactors rejected the leave request: time type ${request.timeType} is not available to you.`);
    const overlaps = this.absences.some((a) => a.userId === me.userId && a.status !== 'REJECTED' && a.status !== 'CANCELLED' && a.startDate <= request.endDate && a.endDate >= request.startDate);
    if (overlaps) throw new SapError('BUSINESS_RULE', 'SuccessFactors rejected the leave request: it overlaps an absence you already have.');
    const days = Math.round((Date.parse(request.endDate) - Date.parse(request.startDate)) / 86_400_000) + 1;
    const absence: Absence = { userId: me.userId, timeType: type.name, startDate: request.startDate, endDate: request.endDate, days, status: 'PENDING' };
    this.absences.push(absence);
    // The request goes to the manager's inbox, as the time type's approval workflow would route it.
    const id = String(4100 + this.approvals.length + this.absences.length);
    if (me.managerId) {
      this.approvals.push({ id, approverId: me.managerId, subjectUserId: me.userId, subjectName: me.displayName, title: type.name, detail: `${request.startDate} to ${request.endDate}, ${days} days`, requestedOn: isoDay(0), absence });
    }
    return { id };
  }

  async listPendingApprovals(ctx: SapCallContext): Promise<ApprovalRequest[]> {
    await this.latency();
    const me = this.caller(ctx);
    return this.approvals.filter((a) => a.approverId === me.userId).map(({ approverId: _approverId, absence: _absence, ...request }) => request);
  }

  async decideApproval(ctx: SapCallContext, requestId: string, decision: 'APPROVE' | 'DECLINE'): Promise<void> {
    await this.latency();
    const me = this.caller(ctx);
    const index = this.approvals.findIndex((a) => a.id === requestId);
    const request = this.approvals[index];
    if (!request) throw new SapError('NOT_FOUND', `Request ${requestId} was not found in SuccessFactors or is no longer pending.`);
    if (request.approverId !== me.userId) throw new SapError('NOT_AUTHORIZED', `SuccessFactors denied the decision: you are not the approver of request ${requestId}.`);
    this.approvals.splice(index, 1);
    if (request.absence) request.absence.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  }

  /** The mock tenant's entities. SuccessFactors leaves out the records a user may not see; it does not report an error. */
  private tables(ctx: SapCallContext): Record<string, Record<string, unknown>[]> {
    return {
      User: EMPLOYEES.map((e) => ({ ...e, title: e.jobTitle, firstName: e.displayName.split(' ')[0], lastName: e.displayName.split(' ')[1], status: e.status === 'ACTIVE' ? 't' : 'f' })),
      EmpJob: JOBS.filter((j) => this.maySeeDetails(ctx, j.userId)).map((j, i) => ({ ...j, seqNumber: 1, emplStatus: 'A', position: `P${1000 + i}`, lastModifiedDateTime: j.startDate })),
      FODepartment: DEPARTMENTS,
      EmpPayCompRecurring: EMPLOYEES.filter((e) => this.maySeeDetails(ctx, e.userId)).map((e) => ({
        userId: e.userId,
        payComponent: 'BASE_SALARY',
        paycompvalue: 9000 + (Number(e.userId) % 9) * 1500,
        currencyCode: 'SAR',
        frequency: 'MON',
        startDate: e.hireDate ?? null,
        bankAccountNumber: 'SA00 0000 0000 0000',
      })),
      RBPRole: [
        { roleId: 10, roleName: 'Employee Self-Service', roleDesc: 'Own data', userType: 'employee' },
        { roleId: 20, roleName: 'Manager Self-Service', roleDesc: 'Team data', userType: 'employee' },
        { roleId: 30, roleName: 'HR Administrator', roleDesc: 'All employee data', userType: 'employee' },
      ],
      JobRequisition: OPEN_POSITIONS.map((p, i) => ({ jobReqId: 5000 + i, internalStatus: 'Open', numberOpenings: 1, department: p.department ?? null, location: p.location ?? null })),
    };
  }

  private select(ctx: SapCallContext, entityName: string, filter: QueryFilter | undefined, orderBy: { field: string; direction: 'asc' | 'desc' }[] | undefined) {
    let rows = (this.tables(ctx)[entityName] ?? []).filter((r) => !filter || matches(r, filter));
    for (const order of [...(orderBy ?? [])].reverse()) {
      const sign = order.direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => sign * String(a[order.field] ?? '').localeCompare(String(b[order.field] ?? ''), 'en', { numeric: true }));
    }
    return rows;
  }

  async queryEntity(ctx: SapCallContext, query: EntityQuery): Promise<EntityQueryResult> {
    await this.latency();
    this.caller(ctx);
    const rows = this.select(ctx, query.entityName, query.filter, query.orderBy);
    return {
      records: rows.slice(0, query.top).map((r) => Object.fromEntries(query.select.map((field) => [field, (r[field] as unknown) ?? null]))),
      hasMore: rows.length > query.top,
    };
  }

  /** Entities of modules the mock tenant does not have are unknown to it, as in a tenant without the license. */
  private entity(ctx: SapCallContext, entityName: string) {
    if (!(entityName in this.tables(ctx))) throw new SapError('NOT_FOUND', `${entityName} records was not found in SuccessFactors.`);
  }

  async readEntity(ctx: SapCallContext, read: EntityRead): Promise<EntityQueryResult> {
    await this.latency();
    this.caller(ctx);
    this.entity(ctx, read.entityName);
    const known = new Set(Object.keys(this.tables(ctx)[read.entityName]![0] ?? {}));
    const unknown = read.filter ? filterFields(read.filter).filter((f) => !known.has(f)) : [];
    if (unknown.length) throw new SapError('INVALID_INPUT', `SuccessFactors rejected the request for ${read.entityName} records: Invalid property names: ${read.entityName}/${unknown.join(', ')}.`);
    const rows = this.select(ctx, read.entityName, read.filter, read.orderBy);
    const pick = (r: Record<string, unknown>) => (read.select ? Object.fromEntries(read.select.map((field) => [field, r[field] ?? null])) : Object.fromEntries(Object.entries(r).filter(([, v]) => v === null || typeof v !== 'object')));
    return { records: rows.slice(0, read.top).map(pick), hasMore: rows.length > read.top };
  }

  async describeEntity(ctx: SapCallContext, entityName: string): Promise<EntityField[]> {
    await this.latency();
    this.caller(ctx);
    this.entity(ctx, entityName);
    const sample = this.tables(ctx)[entityName]![0] ?? {};
    return Object.entries(sample)
      .filter(([, v]) => v === null || typeof v !== 'object')
      .map(([name, v], i) => ({ name, type: typeof v === 'number' ? 'Decimal' : 'String', ...(i === 0 && { key: true }) }));
  }
}
