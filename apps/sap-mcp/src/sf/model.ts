import type { SapCallContext } from '../sap/model.js';
import type { EntityQuery } from './query-builder.js';

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
  /** Reads an entity set. The caller has already checked the query against the entity policy. */
  queryEntity(ctx: SapCallContext, query: EntityQuery): Promise<EntityQueryResult>;
}
