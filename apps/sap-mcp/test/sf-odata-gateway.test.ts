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

  it('reads time account balances and the absences that overlap a date range', async () => {
    const balances: Record<string, unknown[]> = {
      ANNUAL_LEAVE: [{ balance: '10.5', timeUnit: 'DAYS' }, { balance: '4', timeUnit: 'DAYS' }],
      OVERTIME: [{ balance: '6', timeUnit: 'HOURS' }],
      EMPTY: [{ balance: null }],
    };
    sdk.reply = (r) => {
      if (r.url === '/TimeAccount') {
        return {
          d: {
            results: [
              { accountType: 'ANNUAL_LEAVE', accountClosed: false, endDate: '/Date(253402214400000)/' },
              { accountType: 'ANNUAL_LEAVE', accountClosed: false, endDate: '/Date(253402214400000)/' },
              { accountType: 'OVERTIME', accountClosed: false },
              { accountType: 'EMPTY', accountClosed: false },
              { accountType: 'CLOSED', accountClosed: true },
              { accountType: 'EXPIRED', accountClosed: false, endDate: '/Date(1650240000000)/' },
            ],
          },
        };
      }
      if (r.url === '/EmpTimeAccountBalance') return { d: { results: balances[/timeAccountType eq '(\w+)'/.exec(r.params!.$filter!)![1]!] } };
      return { d: { results: [{ userId: '100102', timeType: 'ANNUAL', startDate: '/Date(1650240000000)/', endDate: '/Date(1650412800000)/', quantityInDays: '3', approvalStatus: 'PENDING' }] } };
    };
    const sf = gateway();
    // SuccessFactors requires userId and timeAccountType in the filter, so each open account type is read on its own.
    expect(await sf.getTimeOffBalances(ctx(), '100102')).toEqual([
      { account: 'Annual leave', balance: 14.5, unit: 'DAYS' },
      { account: 'Overtime', balance: 6, unit: 'HOURS' },
    ]);
    expect(sdk.sent.map((s) => s.request.url)).toEqual(['/TimeAccount', '/EmpTimeAccountBalance', '/EmpTimeAccountBalance', '/EmpTimeAccountBalance']);
    expect(sdk.sent[1]!.request.params).toMatchObject({ $filter: "(userId eq '100102' and timeAccountType eq 'ANNUAL_LEAVE')" });
    expect(sdk.sent[1]!.request.params!.$select).toBeUndefined();

    sdk.sent.length = 0;
    expect(await sf.listAbsences(ctx(), ['100102', '100103'], '2022-04-01', '2022-04-30')).toEqual([{ userId: '100102', timeType: 'ANNUAL', startDate: '2022-04-18', endDate: '2022-04-20', days: 3, status: 'PENDING' }]);
    expect(sdk.sent[0]!.request.params!.$filter).toBe("((userId eq '100102' or userId eq '100103') and startDate le datetime'2022-04-30T00:00:00' and endDate ge datetime'2022-04-01T00:00:00')");
    expect(await sf.listAbsences(ctx(), [], '2022-04-01', '2022-04-30')).toEqual([]);
    expect(sdk.sent).toHaveLength(1);
  });

  it('finds the vacant positions below the manager’s own position', async () => {
    sdk.reply = (r) => (r.url === '/EmpJob' ? { d: { results: [{ position: 'P1000' }] } } : { d: { results: [{ code: 'P2041', externalName_defaultValue: 'AP Accountant', location: 'RUH', vacant: true }] } });
    expect(await gateway().listOpenPositions(ctx(), '100101')).toEqual([{ code: 'P2041', title: 'AP Accountant', location: 'RUH' }]);
    expect(sdk.sent[1]!.request.url).toBe('/Position');
    expect(sdk.sent[1]!.request.params!.$filter).toBe("(parentPosition/code eq 'P1000' and vacant eq true)");
  });

  it('lists pending workflow requests and decides one through the workflow function imports', async () => {
    sdk.reply = (r) => {
      if (r.url === '/MyPendingWorkflow') return { d: { results: [{ wfRequestId: '4001', subjectUserId: '100102', subjectUserName: 'Jordan Lee', requestType: 'Time Off', receivedOn: '/Date(1650240000000)/' }, { wfRequestId: null }] } };
      if (r.url === '/User') return { d: { results: [{ userId: '99999' }] } };
      // A forwarded item appears only in the to-do list; 4001 is in both and is listed once.
      return {
        d: {
          results: [
            { todoEntryId: '15520', todoEntryName: 'Requests Waiting for My Approval', categoryLabel: 'Time Off', status: '2', subjectId: '1143', createdDate: '/Date(1650240000000)/', userId: '99999' },
            { todoEntryId: '15521', todoEntryName: 'Requests Waiting for My Approval', categoryLabel: 'Time Off', status: '2', subjectId: '4001', userId: '99999' },
            { todoEntryId: '15522', todoEntryName: 'Complete your profile', categoryLabel: 'Profile', status: '2', subjectId: '77', userId: '99999' },
          ],
        },
      };
    };
    const sf = gateway();
    expect(await sf.listPendingApprovals(ctx())).toEqual([
      { id: '4001', subjectUserId: '100102', subjectName: 'Jordan Lee', title: 'Time Off', requestedOn: '2022-04-18' },
      { id: '1143', title: 'Time Off', detail: 'Requests Waiting for My Approval', requestedOn: '2022-04-18' },
    ]);
    expect(sdk.sent.find((s) => s.request.url === '/TodoEntryV2')!.request.params!.$filter).toBe("userId eq '99999'");

    sdk.sent.length = 0;
    sdk.reply = () => ({ d: { status: 'OK' } });
    await sf.decideApproval(ctx(), '4001', 'APPROVE');
    expect(sdk.sent[0]!.request).toMatchObject({ method: 'post', url: '/approveWfRequest', params: { wfRequestId: '4001L' } });
    await sf.decideApproval(ctx(), '4001', 'DECLINE', "Team's busy");
    expect(sdk.sent[1]!.request).toMatchObject({ method: 'post', url: '/rejectWfRequest', params: { wfRequestId: '4001L', comment: "'Team''s busy'" } });
    await expect(sf.decideApproval(ctx(), '4001L)/x', 'APPROVE')).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    sdk.reply = () => {
      throw Object.assign(new Error('request failed'), { response: { status: 400, data: { error: { message: { value: 'Workflow request is already completed.' } } } } });
    };
    await expect(sf.decideApproval(ctx(), '4001', 'APPROVE')).rejects.toMatchObject({ code: 'BUSINESS_RULE', message: 'SuccessFactors rejected the decision on request 4001: Workflow request is already completed.' });
  });

  it('reads the work locations of all employees in pages', async () => {
    const page = (from: number, count: number) => ({ d: { results: Array.from({ length: count }, (_, i) => ({ userId: String(from + i), displayName: `Employee ${from + i}`, title: 'Analyst', location: 'Riyadh (1000)', country: 'Saudi Arabia' })) } });
    sdk.reply = (r) => (r.params!.$skip === '0' ? page(0, 1000) : page(1000, 3));
    const places = await gateway().listEmployeePlaces(ctx());
    expect(places).toHaveLength(1003);
    expect(places[1002]).toEqual({ userId: '1002', displayName: 'Employee 1002', jobTitle: 'Analyst', location: 'Riyadh (1000)', country: 'Saudi Arabia' });
    expect(sdk.sent.map((s) => s.request.params!.$skip)).toEqual(['0', '1000']);
    expect(sdk.sent[0]!.request.params).toMatchObject({ $top: '1000', $orderby: 'userId asc' });
    // Work location only: no address or personal field is asked for.
    expect(sdk.sent[0]!.request.params!.$select).toBe('userId,displayName,firstName,lastName,title,department,location,city,country');
  });

  it('reads a business case entity with whatever scalar fields the tenant returns', async () => {
    sdk.reply = () => ({ d: { results: [{ __metadata: { uri: 'x' }, jobReqId: '5001', internalStatus: 'Open', createdDateTime: '/Date(1650240000000+0000)/', recruiter: { __deferred: {} }, closedDateTime: null }], __next: 'n' } });
    const r = await gateway().readEntity(ctx(), { entityName: 'JobRequisition', filter: { field: 'internalStatus', operator: 'eq', value: 'Open' }, orderBy: [{ field: 'jobReqId', direction: 'desc' }], top: 25 });
    expect(sdk.sent[0]!.request.url).toBe('/JobRequisition');
    expect(sdk.sent[0]!.request.params).toEqual({ $format: 'json', $filter: "internalStatus eq 'Open'", $orderby: 'jobReqId desc', $top: '25' });
    expect(r).toEqual({ records: [{ jobReqId: '5001', internalStatus: 'Open', createdDateTime: '2022-04-18', closedDateTime: null }], hasMore: true });

    // Fields are named only where a case keeps binary content out.
    await gateway().readEntity(ctx(), { entityName: 'Photo', select: ['userId', 'photoType'], top: 5 });
    expect(sdk.sent[1]!.request.params!.$select).toBe('userId,photoType');
  });

  it('passes on the reason SuccessFactors gives for rejecting a read', async () => {
    sdk.reply = () => {
      throw Object.assign(new Error('request failed'), { response: { status: 400, data: { error: { message: { value: '[COE0021]Invalid property names: FormHeader/subjectUserId.' } } } } });
    };
    await expect(gateway().readEntity(ctx(), { entityName: 'FormHeader', top: 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'SuccessFactors rejected the request for FormHeader records: [COE0021]Invalid property names: FormHeader/subjectUserId.',
    });
  });

  it('describes an entity from its own metadata document', async () => {
    sdk.reply = () =>
      '<edmx:Edmx><Schema><EntityType Name="Other"><Property Name="x" Type="Edm.String"/></EntityType>' +
      '<EntityType Name="JobRequisition"><Key><PropertyRef Name="jobReqId"/></Key>' +
      '<Property Name="jobReqId" Type="Edm.Int64" Nullable="false" sap:filterable="true"/>' +
      '<Property Name="internalStatus" Type="Edm.String" sap:filterable="true"></Property>' +
      '<Property Name="jobDescription" Type="Edm.String" sap:filterable="false"/>' +
      '<NavigationProperty Name="recruiter" Relationship="r"/></EntityType></Schema></edmx:Edmx>';
    expect(await gateway().describeEntity(ctx(), 'JobRequisition')).toEqual([
      { name: 'jobReqId', type: 'Int64', key: true },
      { name: 'internalStatus', type: 'String' },
      { name: 'jobDescription', type: 'String', filterable: false },
    ]);
    expect(sdk.sent[0]!.request).toMatchObject({ url: '/JobRequisition/$metadata', headers: { accept: 'application/xml' } });
    sdk.reply = () => '<edmx:Edmx/>';
    await expect(gateway().describeEntity(ctx(), 'JobRequisition')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('creates a leave request through upsert and passes on a refusal inside a 200 answer', async () => {
    sdk.reply = () => ({ d: [{ key: 'EmployeeTime/externalCode=X', status: 'OK', editStatus: 'INSERTED', httpCode: 204, index: 0 }] });
    const sf = gateway();
    const created = await sf.requestTimeOff(ctx(), { userId: '99999', timeType: 'TT_VAC', startDate: '2026-11-02', endDate: '2026-11-04', comment: 'Family trip' });
    const sent = sdk.sent[0]!.request as SentRequest & { data?: Record<string, unknown> };
    expect(sent).toMatchObject({ method: 'post', url: '/upsert', params: { $format: 'json' } });
    expect(sent.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(sent.data).toEqual({
      __metadata: { uri: 'EmployeeTime' },
      externalCode: created.id,
      userId: '99999',
      timeType: 'TT_VAC',
      startDate: `/Date(${Date.parse('2026-11-02T00:00:00Z')})/`,
      endDate: `/Date(${Date.parse('2026-11-04T00:00:00Z')})/`,
      comment: 'Family trip',
    });
    expect(created.id).toMatch(/^PRW[A-Z0-9]+$/);

    sdk.reply = () => ({ d: [{ status: 'ERROR', message: 'The absence overlaps with another absence.', httpCode: 400, index: 0 }] });
    await expect(sf.requestTimeOff(ctx(), { userId: '99999', timeType: 'TT_VAC', startDate: '2026-11-02', endDate: '2026-11-04' })).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
      message: 'SuccessFactors rejected the leave request: The absence overlaps with another absence.',
    });
  });

  it('lists the time types of the tenant', async () => {
    sdk.reply = () => ({ d: { results: [{ externalCode: 'TT_VAC', externalName_defaultValue: 'Vacation' }, { externalCode: 'TT_SICK' }, { externalName_defaultValue: 'No code' }] } });
    expect(await gateway().listTimeTypes(ctx())).toEqual([
      { code: 'TT_VAC', name: 'Vacation' },
      { code: 'TT_SICK', name: 'TT_SICK' },
    ]);
    expect(sdk.sent[0]!.request.url).toBe('/TimeType');
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
