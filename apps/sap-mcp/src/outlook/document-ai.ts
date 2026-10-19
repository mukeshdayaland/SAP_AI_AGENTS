import { createHash } from 'node:crypto';
import type { Logger } from '@prowess/observability';
import { SapError } from '../sap/model.js';

/**
 * Reads supplier invoices that carry no text (scans, photos) with SAP Document AI
 * (Document Information Extraction, service `sap-document-information-extraction`).
 * The service recognizes the text and returns the invoice fields with a confidence.
 *
 * It is called with the service's own technical client (OAuth client credentials of
 * the service binding), not as the user: the file is the one the user opened, and the
 * result only goes back to that user. Jobs are kept by file hash, so asking again for
 * the same file picks up the running job instead of starting (and paying for) a new one.
 */

export interface ExtractedField {
  name: string;
  value: string;
  /** 0..1 as Document AI reports it. */
  confidence?: number;
}

export interface ExtractedDocument {
  fields: ExtractedField[];
  lineItems: ExtractedField[][];
}

export interface DocumentExtractor {
  readonly mock: boolean;
  extractInvoice(name: string, contentType: string, bytes: Buffer): Promise<ExtractedDocument>;
}

/** Header fields of the standard invoice schema that intake uses. */
export const HEADER_FIELDS = ['documentNumber', 'purchaseOrderNumber', 'documentDate', 'dueDate', 'senderName', 'senderBankAccount', 'paymentTerms', 'currencyCode', 'netAmount', 'taxAmount', 'grossAmount'] as const;
export const LINE_ITEM_FIELDS = ['description', 'materialNumber', 'quantity', 'unitOfMeasure', 'unitPrice', 'netAmount'] as const;

const LABELS: Record<string, string> = {
  senderName: 'Supplier',
  documentNumber: 'Invoice number',
  documentDate: 'Invoice date',
  purchaseOrderNumber: 'Purchase order',
  dueDate: 'Due date',
  paymentTerms: 'Payment terms',
  senderBankAccount: 'Supplier bank account',
  currencyCode: 'Currency',
  netAmount: 'Net amount',
  taxAmount: 'Tax amount',
  grossAmount: 'Total amount due',
};

/** The extracted invoice as text, in the order a person reads an invoice. */
export function documentText(doc: ExtractedDocument): string {
  const header = Object.keys(LABELS)
    .map((name) => doc.fields.find((f) => f.name === name))
    .filter((f): f is ExtractedField => !!f && f.value !== '')
    .map((f) => `${LABELS[f.name]}: ${f.value}`);
  const items = doc.lineItems.map((item, i) => `Item ${i + 1}: ${item.filter((f) => f.value !== '').map((f) => `${f.name} ${f.value}`).join(', ')}`);
  return [...header, ...(items.length ? ['', ...items] : [])].join('\n');
}

export interface DocumentAiCredentials {
  /** Service URL of the binding (`endpoints.backend.url` or `url`). */
  url: string;
  uaa: { url: string; clientid: string; clientsecret: string };
}

export interface DocumentAiConfig {
  credentials: DocumentAiCredentials;
  /** Document AI client the documents are filed under; created on first use if missing. */
  clientId: string;
  logger: Logger;
  /** How long one tool call waits for a job before asking the user to try again. */
  waitMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
}

const API = '/document-information-extraction/v1';
const JOB_CACHE_SIZE = 200;

type Json = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();

function fieldsOf(list: unknown): ExtractedField[] {
  return ((Array.isArray(list) ? list : []) as Json[])
    .map((f) => ({ name: str(f.name), value: str(f.value), ...(typeof f.confidence === 'number' && { confidence: Math.round(f.confidence * 100) / 100 }) }))
    .filter((f) => f.name);
}

export class DocumentAiExtractor implements DocumentExtractor {
  readonly mock = false;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private token?: { value: string; expires: number };
  private clientReady?: Promise<void>;
  private readonly jobs = new Map<string, string>();

  constructor(private readonly cfg: DocumentAiConfig) {
    this.fetchImpl = cfg.fetch ?? fetch;
    this.baseUrl = `${cfg.credentials.url.replace(/\/+$/, '')}${API}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires - 60_000 > Date.now()) return this.token.value;
    const { uaa } = this.cfg.credentials;
    const res = await this.fetchImpl(`${uaa.url.replace(/\/+$/, '')}/oauth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${uaa.clientid}:${uaa.clientsecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(15_000),
    }).catch((err: Error) => {
      this.cfg.logger.warn('document_ai.token_failed', { error: err.message });
      throw new SapError('UNAVAILABLE', 'SAP Document AI is not reachable right now.', true);
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      this.cfg.logger.warn('document_ai.token_refused', { status: res.status });
      throw new SapError('UNAVAILABLE', 'SAP Document AI refused the service credentials. Check the service binding.', res.status >= 500);
    }
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async call(what: string, method: 'GET' | 'POST', path: string, body?: string | FormData, json = false): Promise<Json> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(json && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      this.cfg.logger.warn('document_ai.request_failed', { what, error: (err as Error).message });
      throw new SapError('UNAVAILABLE', `SAP Document AI is not reachable right now (${what}).`, true);
    }
    const data = (await res.json().catch(() => ({}))) as Json;
    if (res.ok) return data;
    const message = str((data.error as Json | undefined)?.message ?? data.message).replace(/\s+/g, ' ').slice(0, 300);
    this.cfg.logger.warn('document_ai.request_failed', { what, status: res.status, ...(message && { message }) });
    if (res.status === 429) throw new SapError('UNAVAILABLE', 'SAP Document AI is limiting requests or the monthly quota of the plan is used up. Try again later.', true);
    if (res.status >= 500) throw new SapError('UNAVAILABLE', `SAP Document AI is not available right now (${what}).`, true);
    throw new SapError('INVALID_INPUT', `SAP Document AI rejected ${what}${message ? `: ${message}` : '.'}`);
  }

  /** The free plan starts without clients; documents must be filed under one. */
  private ensureClient(): Promise<void> {
    this.clientReady ??= (async () => {
      const list = await this.call('the client list', 'GET', '/clients?limit=1000');
      const clients = ((list.payload ?? list.value ?? []) as Json[]).map((c) => str(c.clientId));
      if (clients.includes(this.cfg.clientId)) return;
      await this.call('creating the client', 'POST', '/clients', JSON.stringify({ value: [{ clientId: this.cfg.clientId, clientName: 'Prowess AI invoice intake' }] }), true);
      this.cfg.logger.info('document_ai.client_created', { clientId: this.cfg.clientId });
    })().catch((err: unknown) => {
      this.clientReady = undefined;
      throw err;
    });
    return this.clientReady;
  }

  async extractInvoice(name: string, contentType: string, bytes: Buffer): Promise<ExtractedDocument> {
    const key = createHash('sha256').update(bytes).digest('hex');
    let id = this.jobs.get(key);
    if (!id) {
      await this.ensureClient();
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), name);
      form.append(
        'options',
        JSON.stringify({
          clientId: this.cfg.clientId,
          documentType: 'invoice',
          receivedDate: new Date().toISOString().slice(0, 10),
          extraction: { headerFields: [...HEADER_FIELDS], lineItemFields: [...LINE_ITEM_FIELDS] },
        }),
      );
      const job = await this.call(`reading "${name}"`, 'POST', '/document/jobs', form);
      id = str(job.id);
      if (!id) throw new SapError('UNAVAILABLE', 'SAP Document AI did not accept the document.', true);
      if (this.jobs.size >= JOB_CACHE_SIZE) this.jobs.clear();
      this.jobs.set(key, id);
    }

    const deadline = Date.now() + (this.cfg.waitMs ?? 18_000);
    for (;;) {
      const job = await this.call(`the result for "${name}"`, 'GET', `/document/jobs/${encodeURIComponent(id)}`);
      const status = str(job.status).toUpperCase();
      if (status === 'DONE') {
        const extraction = (job.extraction ?? {}) as Json;
        return {
          fields: fieldsOf(extraction.headerFields),
          lineItems: ((Array.isArray(extraction.lineItems) ? extraction.lineItems : []) as unknown[]).map(fieldsOf).slice(0, 50),
        };
      }
      if (status === 'FAILED') {
        this.jobs.delete(key);
        throw new SapError('NOT_SUPPORTED', `SAP Document AI could not read "${name}". Enter the invoice by hand.`);
      }
      if (Date.now() + (this.cfg.pollMs ?? 1_500) > deadline) {
        throw new SapError('UNAVAILABLE', `SAP Document AI is still reading "${name}". Ask again in a minute; the result is kept.`, true);
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollMs ?? 1_500));
    }
  }
}

/**
 * Mock Document AI for local development and CI: knows the scanned invoices of the
 * mock mailbox by file name and recognizes nothing else.
 */
export class MockDocumentExtractor implements DocumentExtractor {
  readonly mock = true;

  constructor(private readonly known: Map<string, ExtractedDocument>) {}

  async extractInvoice(name: string): Promise<ExtractedDocument> {
    const hit = this.known.get(name);
    if (!hit) throw new SapError('NOT_SUPPORTED', `No text could be recognized in "${name}". Enter the invoice by hand.`);
    return structuredClone(hit);
  }
}

/** Credentials from a `sap-document-information-extraction` service binding, or a service key given as JSON. */
export function documentAiCredentials(vcap: string | undefined, serviceKeyJson: string | undefined): DocumentAiCredentials | undefined {
  let creds: Json | undefined;
  if (serviceKeyJson) {
    try {
      creds = JSON.parse(serviceKeyJson) as Json;
    } catch {
      throw new Error('DOCUMENT_AI_SERVICE_KEY must be the JSON service key of SAP Document AI');
    }
  } else if (vcap) {
    try {
      const services = JSON.parse(vcap) as Record<string, { credentials?: Json }[]>;
      creds = services['sap-document-information-extraction']?.[0]?.credentials;
    } catch {
      return undefined;
    }
  }
  if (!creds) return undefined;
  const uaa = creds.uaa as Json | undefined;
  const url = str(((creds.endpoints as Json | undefined)?.backend as Json | undefined)?.url) || str(creds.url);
  if (!url || !uaa?.url || !uaa.clientid || !uaa.clientsecret) throw new Error('The SAP Document AI credentials need url and uaa (url, clientid, clientsecret)');
  return { url, uaa: { url: str(uaa.url), clientid: str(uaa.clientid), clientsecret: str(uaa.clientsecret) } };
}
