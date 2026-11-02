import { describe, expect, it } from 'vitest';
import { failureNotice } from '../src/conversations/notice.js';

describe('failure notices', () => {
  it('tells the user to check SAP before retrying a write whose result is unknown', () => {
    const notice = failureNotice({ code: 'SAP_OUTCOME_UNKNOWN', message: 'SAP did not answer in time.', correlationId: 'PRW-20261018-F9F1-5518593f52cf', retryPrompt: 'Post it' });
    expect(notice.data).toMatchObject({ kind: 'OUTCOME_UNKNOWN', title: 'Result unknown — check SAP', reference: 'PRW-20261018-F9F1-5518593f52cf' });
    expect(notice.data.action).toMatch(/Check in SAP before you try again/);
    // Sending the same write again could make it twice, so no "Try again" is offered.
    expect(notice.data.retryPrompt).toBeUndefined();
  });

  it('treats a timed-out tool call outside a confirmed write as a temporary failure', () => {
    expect(failureNotice({ code: 'TOOL_TIMEOUT', correlationId: 'PRW-1' }).data.kind).toBe('UNAVAILABLE');
  });
});
