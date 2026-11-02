import { SapError } from '../sap/model.js';

/**
 * Builds SuccessFactors OData V2 requests from structured input. Nothing a
 * model supplies is interpolated as it is: field names must be identifiers,
 * values become escaped literals and the entity name is reduced to an
 * identifier, which rules out $filter, $select and path injection.
 */

// OData field or navigation path (`manager/userId`).
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/;

export const FILTER_OPERATORS = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'startswith', 'endswith'] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type FilterValue = string | number | boolean;

export interface SimpleFilter {
  field: string;
  operator: FilterOperator;
  value: FilterValue;
}
export type QueryFilter = SimpleFilter | { and: QueryFilter[] } | { or: QueryFilter[] };

export interface OrderBy {
  field: string;
  direction: 'asc' | 'desc';
}

export interface EntityQuery {
  entityName: string;
  select: string[];
  filter?: QueryFilter;
  expand?: string[];
  orderBy?: OrderBy[];
  top: number;
  /** Effective-dated entities return only the current record unless a date range is given. */
  fromDate?: string;
  toDate?: string;
}

export function assertSafeFieldName(field: string): string {
  if (!FIELD_NAME.test(field)) throw new SapError('INVALID_INPUT', `"${field.slice(0, 40)}" is not a valid field name.`);
  return field;
}

export function formatLiteral(value: FilterValue): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // A date-time literal passes only when its content cannot close the literal early.
  const dateTime = /^datetime(offset)?'([^']*)'$/i.exec(value);
  if (dateTime) {
    if (!/^[0-9T:.+\- Z]+$/.test(dateTime[2]!)) throw new SapError('INVALID_INPUT', 'The date-time value is not valid.');
    return value;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildFilter(filter: QueryFilter): string {
  if ('and' in filter) return `(${filter.and.map(buildFilter).join(' and ')})`;
  if ('or' in filter) return `(${filter.or.map(buildFilter).join(' or ')})`;
  const field = assertSafeFieldName(filter.field);
  const value = formatLiteral(filter.value);
  if (filter.operator === 'contains') return `substringof(${value},${field})`;
  if (filter.operator === 'startswith' || filter.operator === 'endswith') return `${filter.operator}(${field},${value})`;
  return `${field} ${filter.operator} ${value}`;
}

/** Every field a filter names, so a field policy can check them all. */
export function filterFields(filter: QueryFilter): string[] {
  if ('and' in filter) return filter.and.flatMap(filterFields);
  if ('or' in filter) return filter.or.flatMap(filterFields);
  return [filter.field];
}

/** `/EmpJob`. Anything that is not part of an identifier is dropped. */
export function entityPath(entityName: string): string {
  const name = entityName.replace(/[^A-Za-z0-9_]/g, '');
  if (!name) throw new SapError('INVALID_INPUT', 'The entity name is not valid.');
  return `/${name}`;
}

/** `/User('100045')` */
export function entityKeyPath(entityName: string, key: FilterValue): string {
  return `${entityPath(entityName)}(${formatLiteral(key)})`;
}

/** System query options of a collection read. Values are not URL-encoded yet. */
export function buildQueryParams(query: EntityQuery): Record<string, string> {
  if (!query.select.length) throw new SapError('INVALID_INPUT', 'At least one field must be selected.');
  return {
    $format: 'json',
    $select: query.select.map(assertSafeFieldName).join(','),
    ...(query.filter && { $filter: buildFilter(query.filter) }),
    ...(query.expand?.length && { $expand: query.expand.map(assertSafeFieldName).join(',') }),
    ...(query.orderBy?.length && { $orderby: query.orderBy.map((o) => `${assertSafeFieldName(o.field)} ${o.direction}`).join(',') }),
    $top: String(query.top),
    ...(query.fromDate && { fromDate: query.fromDate }),
    ...(query.toDate && { toDate: query.toDate }),
  };
}
