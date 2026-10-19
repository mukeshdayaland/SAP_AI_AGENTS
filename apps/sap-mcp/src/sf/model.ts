import type { SapCallContext } from '../sap/model.js';
import type { EntityQuery, QueryFilter } from './query-builder.js';

/**
 * SuccessFactors domain model, the port between the `sf` tools and the system
 * behind them. Gateways raise `SapError`, so the MCP server reports a
 * SuccessFactors failure the same way as an S/4HANA one.
 */

export interface Employee {
  userId: string;
  displayName: string;
  /** Business e-mail. Shown on the employee card, never sent to the model. */
  email?: string;
  jobTitle?: string;
  department?: string;
  division?: string;
  location?: string;
  managerId?: string;
  managerName?: string;
  hireDate?: string;
  status: 'ACTIVE' | 'INACTIVE';
}

/** One effective-dated job information record (EmpJob), newest first. */
export interface JobHistoryEntry {
  startDate: string;
  endDate?: string;
  jobTitle?: string;
  department?: string;
  division?: string;
  location?: string;
  company?: string;
  managerId?: string;
  event?: string;
  eventReason?: string;
}

/** An employee with the place they work at. Feeds the employee map; no home address is read. */
export interface EmployeePlace {
  userId: string;
  displayName: string;
  jobTitle?: string;
  department?: string;
  /** Work location as SuccessFactors names it, e.g. "Riyadh (1000)". */
  location?: string;
  city?: string;
  /** Country as held on the user record: an ISO code in some tenants, a name in others. */
  country?: string;
}

/** What is left on one time account (annual leave, sick leave, …). */
export interface TimeOffBalance {
  account: string;
  balance: number;
  unit: 'DAYS' | 'HOURS';
}

/** A kind of time off, such as annual or sick leave. */
export interface TimeType {
  code: string;
  name: string;
}

/** A leave request the caller makes for themselves. Dates are YYYY-MM-DD, both days included. */
export interface NewTimeOff {
  userId: string;
  timeType: string;
  startDate: string;
  endDate: string;
  comment?: string;
}

export type AbsenceStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface Absence {
  userId: string;
  timeType: string;
  startDate: string;
  endDate: string;
  days?: number;
  status: AbsenceStatus;
}

/** A vacant position below a manager. */
export interface OpenPosition {
  code: string;
  title?: string;
  department?: string;
  location?: string;
}

/** A workflow request waiting for the caller's decision. */
export interface ApprovalRequest {
  id: string;
  subjectUserId?: string;
  subjectName?: string;
  /** What is asked for: "Annual leave", "Promotion", … */
  title: string;
  detail?: string;
  requestedOn?: string;
}

/** A read of one entity whose fields are not named: everything the tenant returns comes back. */
export interface EntityRead {
  entityName: string;
  filter?: QueryFilter;
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  /** Named only to keep binary or very large fields out. */
  select?: string[];
  top: number;
}

/** One property of an entity, as the tenant defines it. */
export interface EntityField {
  name: string;
  type?: string;
  key?: boolean;
  /** False when SuccessFactors does not accept the field in a filter. */
  filterable?: boolean;
}

export interface EntityQueryResult {
  records: Record<string, unknown>[];
  /** SuccessFactors holds more records than this page. */
  hasMore: boolean;
}

/** How the signed-in user is matched to a SuccessFactors user. */
export const USER_MAPPINGS = ['email', 'username', 'userId'] as const;
export type UserMapping = (typeof USER_MAPPINGS)[number];

export interface SfGateway {
  readonly systemId: string;
  readonly mock: boolean;

  /** The SuccessFactors user id of the caller. */
  whoAmI(ctx: SapCallContext): Promise<string>;
  getEmployee(ctx: SapCallContext, userId: string): Promise<Employee>;
  listDirectReports(ctx: SapCallContext, managerId: string): Promise<Employee[]>;
  searchEmployees(ctx: SapCallContext, query: string): Promise<Employee[]>;
  getJobHistory(ctx: SapCallContext, userId: string): Promise<JobHistoryEntry[]>;

  /** Every active employee the caller may see, with their work location. */
  listEmployeePlaces(ctx: SapCallContext): Promise<EmployeePlace[]>;

  getTimeOffBalances(ctx: SapCallContext, userId: string): Promise<TimeOffBalance[]>;
  /** Absences of the given employees that overlap the date range (YYYY-MM-DD), earliest first. */
  listAbsences(ctx: SapCallContext, userIds: string[], from: string, to: string): Promise<Absence[]>;
  listOpenPositions(ctx: SapCallContext, managerId: string): Promise<OpenPosition[]>;
  /** The time types of the tenant. Which of them an employee may request is decided by SuccessFactors. */
  listTimeTypes(ctx: SapCallContext): Promise<TimeType[]>;
  /** Creates a leave request. SuccessFactors starts its approval workflow; the id is the new absence record. */
  requestTimeOff(ctx: SapCallContext, request: NewTimeOff): Promise<{ id: string }>;

  /** Workflow requests waiting for the caller's decision. */
  listPendingApprovals(ctx: SapCallContext): Promise<ApprovalRequest[]>;
  /** Approves or declines a workflow request as the caller. SuccessFactors decides whether the caller may. */
  decideApproval(ctx: SapCallContext, requestId: string, decision: 'APPROVE' | 'DECLINE', comment?: string): Promise<void>;
  /** Reads an entity set. The caller has already checked the query against the entity policy. */
  queryEntity(ctx: SapCallContext, query: EntityQuery): Promise<EntityQueryResult>;
  /** Reads an entity with whatever fields the tenant returns. Only for the fixed entities of the business cases. */
  readEntity(ctx: SapCallContext, read: EntityRead): Promise<EntityQueryResult>;
  /** The properties of an entity in this tenant. */
  describeEntity(ctx: SapCallContext, entityName: string): Promise<EntityField[]>;
}
