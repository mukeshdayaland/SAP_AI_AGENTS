import { createLogger } from '@prowess/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SentRequest {
  method: string;
  url: string;
  params?: Record<string, string>;
  headers: Record<string, string>;
}

// The SAP Cloud SDK is replaced by a recorder: these tests check what the gateway sends and how it reads replies.
const sdk = vi.hoisted(() => ({
  sent: [] as { destination: { destinationName: string; jwt?: string }; request: SentRequest }[],
  reply: (_request: SentRequest): unknown => ({}),
}));

vi.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: async (destination: { destinationName: string; jwt?: string }, request: SentRequest) => {
    sdk.sent.push({ destination, request });
    return { data: sdk.reply(request) };
  },
}));

const { SfODataGateway } = await import('../src/sf/odata-gateway.js');

const logger = createLogger({ service: 't', level: 'error', sink: () => {} });
const gateway = (userMapping: 'email' | 'username' | 'userId' = 'email') => new SfODataGateway({ destinationName: 'SF_ODATA', systemId: 'SF-DEV', userMapping, logger });
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const ctx = (claims: Record<string, unknown> = { email: 'jordan.lee@example.com', user_name: 'jlee' }) => ({ principal: { sub: 'P000123', tenant: 't1' }, userJwt: jwt(claims), correlationId: 'PRW-1' }) as never;
const rejected = (status: number) => Object.assign(new Error('request failed'), { response: { status } });

const jordan = {
  userId: '100102',
  displayName: 'Jordan Lee',
  email: 'jordan.lee@example.com',
  title: 'AP Accountant',
  department: 'Accounts Payable (D003)',
  location: 'Jeddah',
  status: 't',
  hireDate: '/Date(1650240000000)/',
  manager: { userId: '100101', displayName: 'Alex Morgan' },
};

beforeEach(() => {
  sdk.sent.length = 0;
  sdk.reply = () => ({});
});

describe('SuccessFactors OData gateway', () => {
  it('reads an employee by key as the end user', async () => {
    sdk.reply = () => ({ d: jordan });
    const e = await gateway().getEmployee(ctx(), '100102');

    const { destination, request } = sdk.sent[0]!;
    expect(destination).toEqual({ destinationName: 'SF_ODATA', jwt: expect.any(String) });
    expect(request.method).toBe('get');
    expect(request.url).toBe("/User('100102')");
    expect(request.params).toMatchObject({ $format: 'json', $expand: 'manager' });
    expect(request.params!.$select).toContain('manager/displayName');
    expect(request.headers).toMatchObject({ 'x-correlation-id': 'PRW-1' });
    expect(e).toEqual({
      userId: '100102',
      displayName: 'Jordan Lee',
      email: 'jordan.lee@example.com',
      jobTitle: 'AP Accountant',
      department: 'Accounts Payable (D003)',
      location: 'Jeddah',
      managerId: '100101',
      managerName: 'Alex Morgan',
      hireDate: '2022-04-18',
      status: 'ACTIVE',
    });
  });

  it('refuses a call without an end-user token', async () => {
    await expect(gateway().getEmployee({ principal: { sub: 'x', tenant: 't1' }, correlationId: 'c' } as never, '1')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(sdk.sent).toHaveLength(0);
  });

  it('finds the SuccessFactors user by the e-mail address of the login and remembers it', async () => {
    sdk.reply = () => ({ d: { results: [{ userId: '100102' }] } });
    const sf = gateway('email');
    expect(await sf.whoAmI(ctx())).toBe('100102');
    expect(await sf.whoAmI(ctx())).toBe('100102');
    expect(sdk.sent).toHaveLength(1);
    expect(sdk.sent[0]!.request.url).toBe('/User');
    expect(sdk.sent[0]!.request.params).toMatchObject({ $filter: "email eq 'jordan.lee@example.com'", $select: 'userId', $top: '2' });
  });

  it('maps by user name or takes the login as the user id', async () => {
    sdk.reply = () => ({ d: { results: [{ userId: '100102' }] } });
    await gateway('username').whoAmI(ctx());
    expect(sdk.sent[0]!.request.params!.$filter).toBe("username eq 'jlee'");
    expect(await gateway('userId').whoAmI(ctx())).toBe('jlee');
    expect(sdk.sent).toHaveLength(1);
  });

  it('does not guess when no user or more than one matches the login', async () => {
    sdk.reply = () => ({ d: { results: [] } });
    await expect(gateway().whoAmI(ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    sdk.reply = () => ({ d: { results: [{ userId: '1' }, { userId: '2' }] } });
    await expect(gateway().whoAmI(ctx())).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
  });

  it('lists direct reports through the manager navigation', async () => {
    sdk.reply = () => ({ d: { results: [jordan] } });
    const team = await gateway().listDirectReports(ctx(), '100101');
    expect(sdk.sent[0]!.request.params).toMatchObject({ $filter: "manager/userId eq '100101'", $expand: 'manager', $top: '200' });
    expect(team.map((e) => e.userId)).toEqual(['100102']);
  });

  it('reads the whole effective-dated job history', async () => {
    sdk.reply = () => ({
      d: {
        results: [
          { userId: '100102', startDate: '/Date(1719792000000)/', endDate: '/Date(253402214400000)/', jobTitle: 'AP Accountant', location: 'Jeddah', event: 'Transfer', managerId: '100101' },
          { userId: '100102', startDate: '/Date(1650240000000)/', endDate: '/Date(1719705600000+0000)/', jobTitle: 'AP Accountant', location: 'Riyadh', event: 'Hire' },
        ],
      },
    });
    const history = await gateway().getJobHistory(ctx(), '100102');
    expect(sdk.sent[0]!.request.url).toBe('/EmpJob');
    expect(sdk.sent[0]!.request.params).toMatchObject({ $filter: "userId eq '100102'", $orderby: 'startDate desc', fromDate: '1900-01-01', toDate: '9999-12-31' });
    expect(history).toEqual([
      { startDate: '2024-07-01', jobTitle: 'AP Accountant', location: 'Jeddah', managerId: '100101', event: 'Transfer' },
      { startDate: '2022-04-18', endDate: '2024-06-30', jobTitle: 'AP Accountant', location: 'Riyadh', event: 'Hire' },
    ]);
  });

  it('returns only the selected fields of a generic query', async () => {
    sdk.reply = () => ({ d: { results: [{ __metadata: { uri: 'x' }, code: 'P1', effectiveStartDate: '/Date(1650240000000)/', vacant: true, companyNav: { __deferred: {} }, secret: 'no' }], __next: 'https://sf/odata/v2/Position?$skiptoken=1' } });
    const r = await gateway().queryEntity(ctx(), { entityName: 'Position', select: ['code', 'effectiveStartDate', 'vacant', 'companyNav', 'targetFTE'], filter: { field: 'vacant', operator: 'eq', value: true }, top: 5 });
    expect(sdk.sent[0]!.request.params).toMatchObject({ $filter: 'vacant eq true', $top: '5' });
    expect(r).toEqual({ records: [{ code: 'P1', effectiveStartDate: '2022-04-18', vacant: true, companyNav: null, targetFTE: null }], hasMore: true });
  });

  it('maps SuccessFactors failures to safe errors', async () => {
    const failWith = (status: number) => {
      sdk.reply = () => {
        throw rejected(status);
      };
      return gateway().getEmployee(ctx(), '100102');
    };
    await expect(failWith(403)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED', message: 'SuccessFactors denied access to Employee 100102.' });
    await expect(failWith(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(failWith(429)).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    await expect(failWith(500)).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });
});
