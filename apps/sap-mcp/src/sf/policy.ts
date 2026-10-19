import { SapError } from '../sap/model.js';

/**
 * Which SuccessFactors entities and fields the generic query tool may read.
 * Deny by default: an entity that is not listed cannot be queried, and only
 * listed fields can be selected, filtered or sorted. SuccessFactors role-based
 * permissions still apply on top, for the propagated user.
 *
 * The format is the one of the SuccessFactors MCP server this was ported from,
 * so its `validate_allowlist.py` can check a list against tenant metadata.
 */

const OPERATIONS = ['read', 'delta', 'upsert', 'delete'] as const;
export type EntityOperation = (typeof OPERATIONS)[number];

export interface AllowedEntity {
  entityName: string;
  operations: EntityOperation[];
  fields: string[];
  /** Returned as `[REDACTED]`, and refused in a filter or a sort order. */
  sensitiveFields: string[];
  keyFields: string[];
  notes?: string;
}

export const REDACTED = '[REDACTED]';
/** Rows an unfiltered query may return. */
export const UNFILTERED_TOP = 50;
export const MAX_TOP = 200;

/**
 * Bundled default: organizational data only. Personal data entities
 * (PerPersonal, compensation, …) are left out and must be added on purpose.
 * Field names follow the standard data model; check them against the tenant.
 */
export const DEFAULT_ALLOWLIST: Record<string, unknown> = {
  User: {
    operations: ['read'],
    keyFields: ['userId'],
    fields: ['userId', 'username', 'displayName', 'firstName', 'lastName', 'email', 'title', 'department', 'division', 'location', 'country', 'city', 'status', 'hireDate', 'timeZone', 'lastModifiedDateTime'],
    sensitiveFields: ['email'],
  },
  EmpJob: {
    operations: ['read'],
    keyFields: ['userId', 'startDate', 'seqNumber'],
    fields: ['userId', 'startDate', 'endDate', 'seqNumber', 'jobTitle', 'jobCode', 'position', 'company', 'businessUnit', 'division', 'department', 'location', 'costCenter', 'managerId', 'emplStatus', 'employeeClass', 'employmentType', 'event', 'eventReason', 'fte', 'standardHours', 'lastModifiedDateTime'],
  },
  EmpEmployment: {
    operations: ['read'],
    keyFields: ['personIdExternal', 'userId'],
    fields: ['personIdExternal', 'userId', 'startDate', 'endDate', 'originalStartDate', 'seniorityDate', 'lastDateWorked', 'lastModifiedDateTime'],
    sensitiveFields: ['personIdExternal'],
  },
  Position: {
    operations: ['read'],
    keyFields: ['code', 'effectiveStartDate'],
    fields: ['code', 'externalName_defaultValue', 'effectiveStartDate', 'effectiveStatus', 'company', 'businessUnit', 'division', 'department', 'location', 'jobCode', 'vacant', 'targetFTE'],
  },
  FOCompany: { operations: ['read'], keyFields: ['externalCode', 'startDate'], fields: ['externalCode', 'startDate', 'endDate', 'name', 'description', 'country', 'currency', 'status'] },
  FODepartment: { operations: ['read'], keyFields: ['externalCode', 'startDate'], fields: ['externalCode', 'startDate', 'endDate', 'name', 'description', 'parent', 'headOfUnit', 'status'] },
  FODivision: { operations: ['read'], keyFields: ['externalCode', 'startDate'], fields: ['externalCode', 'startDate', 'endDate', 'name', 'description', 'parent', 'headOfUnit', 'status'] },
  FOLocation: { operations: ['read'], keyFields: ['externalCode', 'startDate'], fields: ['externalCode', 'startDate', 'endDate', 'name', 'description', 'timezone', 'status'] },
  FOJobCode: { operations: ['read'], keyFields: ['externalCode', 'startDate'], fields: ['externalCode', 'startDate', 'endDate', 'name', 'description', 'jobLevel', 'status'] },
};

const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

function normalize(name: string, value: unknown, source: string): AllowedEntity {
  // A wildcard would open every entity, including personal data, without redaction.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`${source}: "${name}" is not an entity name; wildcards are not supported`);
  if (typeof value !== 'object' || value === null) throw new Error(`${source}: entry "${name}" must be an object`);
  const entry = value as Record<string, unknown>;
  const operations = strings(entry.operations);
  if (!operations.length) throw new Error(`${source}: entry "${name}" needs a non-empty "operations" array`);
  const invalid = operations.filter((op) => !OPERATIONS.includes(op as EntityOperation));
  if (invalid.length) throw new Error(`${source}: entry "${name}" has invalid operations: ${invalid.join(', ')}`);
  const fields = strings(entry.fields);
  if (!fields.length) throw new Error(`${source}: entry "${name}" needs a non-empty "fields" array; allowAllFields is not supported`);
  return {
    entityName: name,
    operations: operations as EntityOperation[],
    fields,
    sensitiveFields: strings(entry.sensitiveFields),
    keyFields: strings(entry.keyFields),
    ...(typeof entry.notes === 'string' && { notes: entry.notes }),
  };
}

export class EntityPolicy {
  private readonly entities: Map<string, AllowedEntity>;

  constructor(allowlist: Record<string, unknown> = DEFAULT_ALLOWLIST, source = 'entity allow-list') {
    this.entities = new Map(Object.entries(allowlist).map(([name, value]) => [name, normalize(name, value, source)]));
  }

  /** `SF_ENTITY_ALLOWLIST_JSON` replaces the bundled list. Invalid JSON fails startup rather than falling back. */
  static fromJson(raw: string | undefined): EntityPolicy {
    if (!raw?.trim()) return new EntityPolicy();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`SF_ENTITY_ALLOWLIST_JSON is not valid JSON: ${(err as Error).message}`, { cause: err });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('SF_ENTITY_ALLOWLIST_JSON must be an object of { entityName: definition }');
    return new EntityPolicy(parsed as Record<string, unknown>, 'SF_ENTITY_ALLOWLIST_JSON');
  }

  list(): AllowedEntity[] {
    return [...this.entities.values()];
  }

  /**
   * The entity, when it may be read and every named field is on its list.
   * Fields used in a filter or a sort order must not be sensitive, or the
   * redacted value could be found out by probing.
   */
  assertReadable(entityName: string, select: string[], conditionFields: string[] = []): AllowedEntity {
    const entity = this.entities.get(entityName);
    if (!entity?.operations.includes('read')) {
      throw new SapError('NOT_SUPPORTED', `Entity ${entityName.slice(0, 60)} is not on the SuccessFactors allow-list of this workspace. Allowed: ${[...this.entities.keys()].join(', ')}.`);
    }
    const blocked = [...new Set([...select, ...conditionFields].filter((f) => !entity.fields.includes(f)))];
    if (blocked.length) {
      throw new SapError('INVALID_INPUT', `Field(s) ${blocked.join(', ').slice(0, 120)} of ${entityName} are not allowed. Allowed: ${entity.fields.join(', ')}.`);
    }
    const sensitive = [...new Set(conditionFields.filter((f) => entity.sensitiveFields.includes(f)))];
    if (sensitive.length) throw new SapError('INVALID_INPUT', `Field(s) ${sensitive.join(', ')} of ${entityName} are protected and cannot be used to filter or sort.`);
    return entity;
  }

  redact(entity: AllowedEntity, record: Record<string, unknown>): Record<string, unknown> {
    if (!entity.sensitiveFields.length) return record;
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, entity.sensitiveFields.includes(k) && v != null && v !== '' ? REDACTED : v]));
  }

  /** A query without a filter returns at most a small page. */
  boundedTop(requested: number | undefined, filtered: boolean): number {
    return Math.min(requested ?? UNFILTERED_TOP, filtered ? MAX_TOP : UNFILTERED_TOP);
  }
}
