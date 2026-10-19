import { z } from 'zod';
import { SapError } from '../sap/model.js';
import { BUSINESS_CASES, CASE_ENTITIES, CASE_MODULES, findCase, isProtectedField, type BusinessCase } from '../sf/business-cases.js';
import { FILTER_OPERATORS, type QueryFilter } from '../sf/query-builder.js';
import { defineTool, now, type ToolContext } from './types.js';

/** Columns of a result table, and rows read when the caller names no limit. */
const TABLE_COLUMNS = 10;
const DEFAULT_TOP = 25;
const MAX_TOP = 100;
const DELTA_DAYS = 7;

const source = (ctx: ToolContext, objectType: string, objectId: string) => ({ system: ctx.sf.gateway.systemId, objectType, objectId: objectId.slice(0, 80), retrievedAt: now(), mock: ctx.sf.gateway.mock });
const cell = (v: unknown): string | number | null => (v == null || v === '' ? null : typeof v === 'number' ? v : String(v).slice(0, 300));
const needs = (c: BusinessCase) => (c.unavailable ? 'Not available here' : !c.input ? 'Nothing' : c.input.defaultsToCaller ? `${c.input.label} (yours when left out)` : c.input.label);

/** Every runnable case in one line each, so the model can pick a case without listing them first. */
const CASE_INDEX = BUSINESS_CASES.filter((c) => !c.unavailable)
  .map((c) => `${c.id} ${c.title}${c.input ? ` (needs ${c.input.label.toLowerCase()})` : ''}`)
  .join('; ');

/** A field or navigation path of the case's entity. */
const field = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,59}(\/[A-Za-z_][A-Za-z0-9_]{0,59}){0,2}$/);

/** The filter of a case for the value the user gave, or for the calling user. */
async function caseFilter(c: BusinessCase, value: string | undefined, ctx: ToolContext): Promise<QueryFilter | undefined> {
  const input = c.input;
  if (!input) return undefined;
  if (input.kind === 'since') {
    const since = value ?? new Date(Date.now() - DELTA_DAYS * 86_400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new SapError('INVALID_INPUT', `${c.title} needs a date as YYYY-MM-DD.`);
    return { field: input.field, operator: 'ge', value: `datetimeoffset'${since}T00:00:00Z'` };
  }
  const given = value ?? (input.defaultsToCaller ? await ctx.sf.gateway.whoAmI(ctx.sap) : undefined);
  if (given === undefined) throw new SapError('INVALID_INPUT', `${c.title} needs a value: ${input.label}.`);
  if (input.kind === 'number') {
    if (!/^\d{1,18}$/.test(given)) throw new SapError('INVALID_INPUT', `${input.label} must be a number.`);
    return { field: input.field, operator: 'eq', value: Number(given) };
  }
  return { field: input.field, operator: 'eq', value: given };
}

/** The columns to show: the case's own first, then whatever else the tenant returned, without empty and protected ones. */
function columnsOf(c: BusinessCase, records: Record<string, unknown>[]) {
  const returned = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const filled = returned.filter((name) => records.some((r) => r[name] != null && r[name] !== ''));
  const hidden = filled.filter(isProtectedField);
  const visible = filled.filter((name) => !isProtectedField(name));
  const preferred = (c.columns ?? []).filter((name) => visible.includes(name));
  return { columns: [...preferred, ...visible.filter((name) => !preferred.includes(name))].slice(0, TABLE_COLUMNS), hidden, more: Math.max(0, visible.length - TABLE_COLUMNS) };
}

/** The business cases, for power users: a guided way into the SuccessFactors modules that have no card of their own. */
export const sfCaseTools = [
  defineTool({
    name: 'sf_listBusinessCases',
    domain: 'sf',
    title: 'List business cases',
    description:
      'Show the user the list of SuccessFactors business cases, all or of one module. Call it only when the user asks to see or browse the business cases; to answer a question, pick the case id from the description of sf_runBusinessCase and run it directly.',
    risk: 'READ',
    operation: 'NONE',
    statusLabel: 'Reading the business cases',
    requiredRole: 'AI_POWER_USER',
    input: { module: z.enum(CASE_MODULES).optional().describe('Only the cases of this module') },
    async run({ module }) {
      const cases = BUSINESS_CASES.filter((c) => !module || c.module === module);
      return {
        data: {
          cases: cases.map((c) => ({ id: c.id, module: c.module, title: c.title, needs: needs(c) })),
          summary: `${cases.length} business case(s)${module ? ` in ${module}` : ` across ${new Set(cases.map((c) => c.module)).size} modules`}.`,
        },
        followUps: cases
          .filter((c) => !c.unavailable)
          .slice(0, 3)
          .map((c) => ({ label: c.title, prompt: `Run case ${c.id}.` })),
        components: [
          {
            type: 'business_object_table',
            data: {
              title: module ? `Business cases · ${module}` : 'Business cases',
              columns: [
                { key: 'id', label: 'Case' },
                ...(module ? [] : [{ key: 'module', label: 'Module' }]),
                { key: 'title', label: 'What it shows' },
                { key: 'needs', label: 'Needs' },
              ],
              rows: cases.map((c) => ({ id: c.id, module: c.module, title: c.title, needs: needs(c) })),
            },
          },
        ],
      };
    },
  }),

  defineTool({
    name: 'sf_runBusinessCase',
    domain: 'sf',
    title: 'Run a business case',
    description:
      'Run one SuccessFactors business case by its id and show the records. Pass the value the case needs, for example a user id or a requisition id; cases about an employee run for the current user when no value is given. ' +
      `Cases: ${CASE_INDEX}. ` +
      'If SuccessFactors rejects the default filter, look up the real field names with sf_describeEntity and pass filters instead.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Running the business case',
    requiredRole: 'AI_POWER_USER',
    input: {
      caseId: z.string().trim().regex(/^[A-Za-z]{2,3}-\d{2}$/).describe('Case id, e.g. rcm-01'),
      value: z.string().trim().min(1).max(100).optional().describe('The value the case needs'),
      filters: z
        .array(z.object({ field, operator: z.enum(FILTER_OPERATORS), value: z.union([z.string().max(200), z.number(), z.boolean()]) }))
        .max(5)
        .optional()
        .describe('Replaces the default filter of the case; all conditions must hold'),
      top: z.number().int().min(1).max(MAX_TOP).optional().describe('Maximum number of records'),
    },
    async run({ caseId, value, filters, top }, ctx) {
      const c = findCase(caseId);
      if (!c) throw new SapError('NOT_FOUND', `Business case ${caseId} does not exist. Call sf_listBusinessCases for the ids.`);
      if (c.unavailable) throw new SapError('NOT_SUPPORTED', `${c.title} is not available: ${c.unavailable}`);

      // A protected field is never shown, so it must not be probed through a filter either.
      const probed = filters?.find((f) => isProtectedField(f.field));
      if (probed) throw new SapError('INVALID_INPUT', `${probed.field} is a protected field and cannot be used in a filter.`);
      const filter: QueryFilter | undefined = filters?.length ? { and: filters } : await caseFilter(c, value, ctx);
      const limit = top ?? DEFAULT_TOP;
      const { records, hasMore } = await ctx.sf.gateway
        .readEntity(ctx.sap, { entityName: c.entity, ...(filter && { filter }), ...(c.orderBy && { orderBy: [c.orderBy] }), ...(c.select && { select: c.select }), top: limit })
        .catch((err: unknown) => {
          // A rejected read usually means this tenant names the filter field differently.
          if (err instanceof SapError && err.code === 'INVALID_INPUT') {
            throw new SapError('INVALID_INPUT', `${err.message} Look up the fields of ${c.entity} with sf_describeEntity and run the case again with filters.`);
          }
          if (err instanceof SapError && err.code === 'NOT_FOUND') throw new SapError('NOT_FOUND', `${c.title} is not available: this SuccessFactors tenant has no ${c.entity} (the module may not be in use).`);
          throw err;
        });

      const { columns, hidden, more } = columnsOf(c, records);
      const rows = records.map((r) => Object.fromEntries(columns.map((name) => [name, cell(r[name])])));
      return {
        data: {
          case: c.id,
          title: c.title,
          entity: c.entity,
          records: rows,
          hasMore,
          ...(hidden.length && { protectedFields: hidden }),
          summary:
            `${c.title}: ${rows.length} record(s)${hasMore ? `, more exist beyond the first ${limit}` : ''}.` +
            `${hidden.length ? ` ${hidden.length} protected field(s) are not shown.` : ''}${more ? ` ${more} further field(s) are left out of the table.` : ''}`,
        },
        components: rows.length ? [{ type: 'business_object_table', data: { title: `${c.title} · ${rows.length} record(s)`, columns: columns.map((key) => ({ key, label: key })), rows } }] : [],
        source: source(ctx, c.entity, filters?.map((f) => `${f.field} ${f.operator} ${f.value}`).join(' and ') || value || c.id),
        followUps: [
          ...(hasMore && limit < MAX_TOP ? [{ label: 'Show more records', prompt: `Run case ${c.id}${value ? ` for ${value}` : ''} with up to ${MAX_TOP} records.` }] : []),
          // Other cases of the same module; the value is passed on when it means the same thing.
          ...BUSINESS_CASES.filter((o) => o.module === c.module && o.id !== c.id && !o.unavailable)
            .slice(0, 2)
            .map((o) => ({ label: o.title, prompt: `Run case ${o.id}${value && o.input?.label === c.input?.label ? ` for ${value}` : ''}.` })),
        ],
      };
    },
  }),

  defineTool({
    name: 'sf_describeEntity',
    domain: 'sf',
    title: 'Describe an entity',
    description:
      'Show the fields of a SuccessFactors entity that a business case or sf_queryEntity reads, as this tenant defines them: name, type, key and whether it can be filtered. Use it when a request was rejected because of a field name.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Reading the entity definition',
    requiredRole: 'AI_POWER_USER',
    input: { entityName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/).describe('Entity of a business case, e.g. JobRequisition') },
    async run({ entityName }, ctx) {
      // The entities a power user can read anyway: those of the business cases and of the generic query's allow-list.
      const known = new Set([...CASE_ENTITIES, ...ctx.sf.policy.list().map((e) => e.entityName)]);
      if (!known.has(entityName)) throw new SapError('NOT_SUPPORTED', `${entityName} is not an entity of a business case or of the query allow-list. Entities: ${[...known].join(', ')}.`);
      const fields = await ctx.sf.gateway.describeEntity(ctx.sap, entityName);
      return {
        data: {
          entity: entityName,
          fields: fields.map((f) => ({ ...f, ...(isProtectedField(f.name) && { protected: true }) })),
          summary: `${entityName} has ${fields.length} field(s) in this tenant.`,
        },
        components: [
          {
            type: 'business_object_table',
            data: {
              title: `Fields · ${entityName}`,
              columns: [
                { key: 'name', label: 'Field' },
                { key: 'type', label: 'Type' },
                { key: 'notes', label: 'Notes' },
              ],
              rows: fields.slice(0, 200).map((f) => ({
                name: f.name,
                type: f.type ?? null,
                notes: [f.key && 'key', f.filterable === false && 'not filterable', isProtectedField(f.name) && 'protected, never shown'].filter(Boolean).join(', ') || null,
              })),
            },
          },
        ],
        source: source(ctx, 'EntityDefinition', entityName),
      };
    },
  }),
];
