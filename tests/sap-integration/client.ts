/**
 * Client for the SAP integration tests: signs in as the test user and calls the orchestrator API the way the
 * web app does. Credentials come only from the environment (GitHub Actions secrets); nothing is logged.
 */

const REQUIRED = ['APP_URL', 'XSUAA_URL', 'XSUAA_CLIENT_ID', 'XSUAA_CLIENT_SECRET', 'AIUSER_MAIL', 'AIUSER_PWD'] as const;

export const missingSettings = () => REQUIRED.filter((name) => !process.env[name]);

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Setting ${name} is missing.`);
  return value;
};

/** Test data in SAP: a customer and material that are complete for sales, with stock and a price. */
export const testData = () => ({
  customer: env('SAP_TEST_CUSTOMER'),
  material: env('SAP_TEST_MATERIAL'),
  quantity: env('SAP_TEST_QUANTITY', '1'),
  salesOrganization: env('SAP_TEST_SALES_ORG', '1030'),
  distributionChannel: env('SAP_TEST_DISTRIBUTION_CHANNEL', '10'),
  division: env('SAP_TEST_DIVISION', '00'),
  companyCode: env('SAP_TEST_COMPANY_CODE', '1030'),
});

let token: { value: string; expires: number } | undefined;

/** Access token of the test user: XSUAA password grant, against the IAS origin when one is set. */
async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const form = new URLSearchParams({ grant_type: 'password', username: env('AIUSER_MAIL'), password: env('AIUSER_PWD') });
  if (process.env.IAS_ORIGIN) form.set('login_hint', JSON.stringify({ origin: process.env.IAS_ORIGIN }));
  const basic = Buffer.from(`${env('XSUAA_CLIENT_ID')}:${env('XSUAA_CLIENT_SECRET')}`).toString('base64');
  const res = await fetch(`${env('XSUAA_URL').replace(/\/$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
  });
  if (!res.ok) {
    // The body names the reason (for example invalid credentials or an unknown origin); it holds no secret.
    throw new Error(`Sign-in of the test user failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

export interface ApiResponse {
  status: number;
  json: Record<string, unknown>;
  /** Reference ID of the request in the application logs. */
  reference: string;
}

export async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse> {
  const res = await fetch(`${env('APP_URL').replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      accept: 'application/json',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json, reference: res.headers.get('x-correlation-id') ?? '' };
}

/* ---------------- workflow runs ---------------- */

export type Component = { type: string; data: Record<string, unknown> };
export type Message = { content: string; response?: { components?: Component[]; confirmations?: { id: string; action: string; proposedChange: string }[] } };
export type RunCard = { id: string; status: string; reason?: string; steps: { id: string; title: string; state: string; detail?: string }[] };

/** Every component of a type anywhere in a response, in order. */
export function components(value: unknown, type: string): Component[] {
  const found: Component[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === type && o.data && typeof o.data === 'object') found.push(o as Component);
      Object.values(o).forEach(visit);
    }
  };
  visit(value);
  return found;
}

export const runCard = (value: unknown) => components(value, 'workflow_run').at(-1)?.data as RunCard | undefined;

/** One line per step, for the test report. */
export const describeRun = (card: RunCard | undefined) =>
  card ? `${card.status}${card.reason ? ` (${card.reason})` : ''}: ${card.steps.map((s) => `${s.id}=${s.state}${s.detail ? ` [${s.detail}]` : ''}`).join(', ')}` : 'no run card';

export interface RunOutcome {
  card: RunCard | undefined;
  /** Every response of the run: the start and each confirmation. */
  responses: ApiResponse[];
  log: string[];
}

/** Starts a workflow and confirms each posting it asks for, as the test user would in the UI. */
export async function runWorkflow(workflow: string, input: Record<string, string>): Promise<RunOutcome> {
  const log: string[] = [];
  const start = await api('POST', `/api/v1/workflows/${workflow}/runs`, { input });
  const responses = [start];
  log.push(`start ${workflow} → HTTP ${start.status}, reference ${start.reference}`);
  if (start.status !== 201) {
    log.push(JSON.stringify(start.json).slice(0, 1000));
    return { card: undefined, responses, log };
  }
  let message = start.json.message as Message;
  for (let i = 0; i < 6 && message?.response?.confirmations?.length; i++) {
    const pending = message.response.confirmations[0]!;
    log.push(`confirm "${pending.action}": ${pending.proposedChange}`);
    const res = await api('POST', `/api/v1/actions/${pending.id}/confirm`, {});
    responses.push(res);
    const status = (res.json.confirmation as { status?: string } | undefined)?.status;
    log.push(`  → HTTP ${res.status}, ${status ?? 'no status'}, reference ${res.reference}`);
    if (status !== 'completed') log.push(`  ${JSON.stringify(res.json.result ?? res.json).slice(0, 1000)}`);
    message = (res.json.followUp as Message[] | undefined)?.[0] as Message;
  }
  const card = runCard(responses.map((r) => r.json));
  log.push(`run ${describeRun(card)}`);
  return { card, responses, log };
}
