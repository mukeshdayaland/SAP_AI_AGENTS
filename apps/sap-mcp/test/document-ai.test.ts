import { createLogger } from '@prowess/observability';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { attachmentText } from '../src/outlook/attachment-text.js';
import { DocumentAiExtractor, MockDocumentExtractor, documentAiCredentials } from '../src/outlook/document-ai.js';
import { MOCK_SCANS, MockMailGateway } from '../src/outlook/mock-gateway.js';
import { textPdf } from '../src/outlook/mock-pdf.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import type { SapCallContext } from '../src/sap/model.js';
import { MockSfGateway } from '../src/sf/mock-gateway.js';
import { EntityPolicy } from '../src/sf/policy.js';
import { buildRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';

const logger = createLogger({ service: 't', level: 'error', sink: () => {} });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const KEY = { url: 'https://aiservices-dox.cfapps.eu10.hana.ondemand.com', uaa: { url: 'https://sbx.authentication.eu10.hana.ondemand.com', clientid: 'sb-dox', clientsecret: 's3cret' } };

interface Sent {
  url: string;
  method: string;
  body?: unknown;
}

/** A fake Document AI: the token endpoint, the client list, and jobs that finish after `pendingPolls` polls. */
function fakeDox(opts: { clients?: string[]; pendingPolls?: number; status?: 'DONE' | 'FAILED' } = {}) {
  const sent: Sent[] = [];
  let polls = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.endsWith('/oauth/token')) return json(200, { access_token: 'dox-token', expires_in: 3600 });
    if (url.endsWith('/clients?limit=1000')) return json(200, { payload: (opts.clients ?? ['default']).map((clientId) => ({ clientId })) });
    if (url.endsWith('/clients')) return json(201, { payload: [] });
    if (url.endsWith('/document/jobs') && init.method === 'POST') return json(201, { id: 'job-1', status: 'PENDING' });
    if (url.endsWith('/document/jobs/job-1')) {
      if (polls++ < (opts.pendingPolls ?? 0)) return json(200, { id: 'job-1', status: 'PENDING' });
      return json(200, {
        id: 'job-1',
        status: opts.status ?? 'DONE',
        extraction: {
          headerFields: [
            { name: 'documentNumber', value: 'INV-77', confidence: 0.96 },
            { name: 'purchaseOrderNumber', value: '4500012410', confidence: 0.55 },
            { name: 'grossAmount', value: 190400, confidence: 0.93 },
          ],
          lineItems: [[{ name: 'description', value: 'Seal kit', confidence: 0.8 }]],
        },
      });
    }
    return json(404, { error: { message: 'not found' } });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const extractor = (dox: ReturnType<typeof fakeDox>, waitMs = 1_000) => new DocumentAiExtractor({ credentials: KEY, clientId: 'default', logger, fetch: dox.fetchImpl, waitMs, pollMs: 5 });

describe('SAP Document AI', () => {
  it('uploads the scan as an invoice job with the service credentials and returns the recognized fields', async () => {
    const dox = fakeDox({ pendingPolls: 2 });
    const doc = await extractor(dox).extractInvoice('scan.png', 'image/png', PNG);
    expect(doc.fields).toEqual([
      { name: 'documentNumber', value: 'INV-77', confidence: 0.96 },
      { name: 'purchaseOrderNumber', value: '4500012410', confidence: 0.55 },
      { name: 'grossAmount', value: '190400', confidence: 0.93 },
    ]);
    expect(doc.lineItems).toEqual([[{ name: 'description', value: 'Seal kit', confidence: 0.8 }]]);

    const upload = dox.sent.find((r) => r.url.endsWith('/document-information-extraction/v1/document/jobs'))!;
    expect(upload.url).toBe('https://aiservices-dox.cfapps.eu10.hana.ondemand.com/document-information-extraction/v1/document/jobs');
    const form = upload.body as FormData;
    expect((form.get('file') as File).name).toBe('scan.png');
    const options = JSON.parse(form.get('options') as string);
    expect(options).toMatchObject({ clientId: 'default', documentType: 'invoice', extraction: { headerFields: expect.arrayContaining(['documentNumber', 'purchaseOrderNumber', 'grossAmount', 'senderBankAccount']) } });
    expect(dox.sent.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(1);
  });

  it('creates its client on first use when the plan has none', async () => {
    const dox = fakeDox({ clients: [] });
    await extractor(dox).extractInvoice('scan.png', 'image/png', PNG);
    const created = dox.sent.find((r) => r.url.endsWith('/clients') && r.method === 'POST')!;
    expect(JSON.parse(created.body as string)).toEqual({ value: [{ clientId: 'default', clientName: 'Prowess AI invoice intake' }] });
  });

  it('keeps a job that takes long, so asking again does not upload the file twice', async () => {
    const dox = fakeDox({ pendingPolls: 1_000 });
    const x = extractor(dox, 20);
    await expect(x.extractInvoice('scan.png', 'image/png', PNG)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: /still reading/ });
    await expect(x.extractInvoice('scan.png', 'image/png', PNG)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(dox.sent.filter((r) => r.url.endsWith('/document/jobs') && r.method === 'POST')).toHaveLength(1);
  });

  it('reports a failed job', async () => {
    await expect(extractor(fakeDox({ status: 'FAILED' })).extractInvoice('scan.png', 'image/png', PNG)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('reads the credentials from the service binding or a service key', () => {
    const vcap = JSON.stringify({ 'sap-document-information-extraction': [{ credentials: { ...KEY, endpoints: { backend: { url: 'https://backend.example' } } } }] });
    expect(documentAiCredentials(vcap, undefined)).toEqual({ ...KEY, url: 'https://backend.example' });
    expect(documentAiCredentials(undefined, JSON.stringify(KEY))).toEqual(KEY);
    expect(documentAiCredentials(undefined, undefined)).toBeUndefined();
    expect(() => documentAiCredentials(undefined, '{"url":"x"}')).toThrow(/uaa/);
  });

  it('is configured from the binding, mocked with the mock mailbox, and never mocked in PROD', () => {
    const base = { SERVICE_ASSERTION_SECRET: 'x'.repeat(32) };
    expect(loadConfig(base).documentAi.mode).toBe('mock');
    expect(loadConfig({ ...base, DOCUMENT_AI_SERVICE_KEY: JSON.stringify(KEY) }).documentAi).toMatchObject({ mode: 'service', clientId: 'default', credentials: KEY });
    expect(loadConfig({ ...base, DOCUMENT_AI_MODE: 'off' }).documentAi.mode).toBe('off');
    expect(() => loadConfig({ ...base, DOCUMENT_AI_MODE: 'service' })).toThrow(/sap-document-information-extraction/);
  });
});

describe('reading a scanned invoice', () => {
  it('sends only files without text to Document AI', async () => {
    const calls: string[] = [];
    const ocr = { mock: true, extractInvoice: async (name: string) => (calls.push(name), { fields: [{ name: 'documentNumber', value: 'X1' }], lineItems: [] }) };
    expect((await attachmentText('text.pdf', textPdf(['Invoice 1']), ocr)).extracted).toBeUndefined();
    const scan = await attachmentText('scan.pdf', textPdf([]), ocr);
    expect(scan).toMatchObject({ kind: 'pdf', text: 'Invoice number: X1', pages: 1 });
    expect((await attachmentText('photo.png', PNG, ocr)).kind).toBe('image');
    expect(calls).toEqual(['scan.pdf', 'photo.png']);
    await expect(attachmentText('photo.png', PNG)).rejects.toMatchObject({ code: 'NOT_SUPPORTED', message: /scanned image/ });
  });

  it('reads the scanned invoice in the mock mailbox and names the values it is unsure of', async () => {
    const alex = { principal: { sub: 'alex.morgan@prowess.example', name: 'Alex Morgan' }, correlationId: 't' } as unknown as SapCallContext;
    const ctx: ToolContext = {
      sap: alex,
      gateway: new MockSapGateway(0),
      sf: { gateway: new MockSfGateway(0), policy: new EntityPolicy() },
      outlook: { gateway: new MockMailGateway(0), allowedRecipientDomains: [], documents: new MockDocumentExtractor(MOCK_SCANS) },
    };
    const r = await buildRegistry(new Set(['outlook'] as const)).get('outlook_readAttachment')!.run({ messageId: 'AAMk-alex-007', attachment: 'scan_ABC-INV-2291.png' } as never, ctx);
    expect(r.data).toMatchObject({ readBy: 'SAP Document AI (OCR)', lowConfidence: ['purchaseOrderNumber'], purchaseOrderCandidates: ['4500012345'] });
    expect(r.data.text).toContain('Invoice number: ABC-INV-2291');
    expect(r.data.summary).toMatch(/with SAP Document AI \(scan\)\. Low confidence: purchaseOrderNumber/);
    expect(r.data.notice).toMatch(/confirm them before posting/);
  });
});
