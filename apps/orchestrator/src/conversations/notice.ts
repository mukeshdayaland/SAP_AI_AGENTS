import type { UIComponent } from '@prowess/contracts';

type Notice = Extract<UIComponent, { type: 'notice' }>;
type Kind = Notice['data']['kind'];

/** What the user is told for each kind of failed SAP call: a title and the next step to take. */
const WORDING: Record<Kind, { title: string; action: string }> = {
  NOT_AUTHORIZED: { title: 'SAP did not allow this', action: 'Ask your SAP authorization team for access to this data, then try again. Quote the reference below.' },
  NOT_FOUND: { title: 'Not found in SAP', action: 'Check the number and the company code, then ask again.' },
  BUSINESS_RULE: { title: 'SAP rejected this', action: 'Correct the cause named above, then try again.' },
  UNAVAILABLE: { title: 'SAP could not be reached', action: 'Try again in a moment. If it keeps failing, contact support with the reference below.' },
  NOT_SUPPORTED: { title: 'Not available here', action: 'This has to be done directly in SAP.' },
  INVALID_INPUT: { title: 'The request was not valid', action: 'Check the numbers and dates in your question, then ask again.' },
  OTHER: { title: 'This could not be completed', action: 'Try again, or contact support with the reference below.' },
};

const KIND_BY_CODE: Record<string, Kind> = {
  SAP_NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  SAP_NOT_FOUND: 'NOT_FOUND',
  SAP_BUSINESS_RULE: 'BUSINESS_RULE',
  SAP_UNAVAILABLE: 'UNAVAILABLE',
  TOOL_UNAVAILABLE: 'UNAVAILABLE',
  SAP_NOT_SUPPORTED: 'NOT_SUPPORTED',
  SAP_INVALID_INPUT: 'INVALID_INPUT',
  INVALID_INPUT: 'INVALID_INPUT',
};

export const noticeKind = (code: string | undefined): Kind => KIND_BY_CODE[code ?? ''] ?? 'OTHER';

/**
 * The notice card for a failed SAP call. It carries what happened, what the user
 * can do and a reference for support; internal error codes stay in the technical details.
 */
export function failureNotice(failure: { code?: string | undefined; message?: string | undefined; correlationId: string; retryPrompt?: string }): Notice {
  const kind = noticeKind(failure.code);
  const { title, action } = WORDING[kind];
  return {
    type: 'notice',
    data: {
      kind,
      title,
      message: (failure.message?.trim() || 'SAP returned an error.').slice(0, 400),
      action,
      reference: failure.correlationId.slice(0, 80),
      // Only a temporary failure is worth sending again unchanged.
      ...(kind === 'UNAVAILABLE' && failure.retryPrompt && { retryPrompt: failure.retryPrompt.slice(0, 600) }),
    },
  };
}

/** Tool result for the model after a failed call: the user already has the details. */
export const failureForModel = (message: string | undefined) =>
  JSON.stringify({
    error: message ?? 'The SAP call failed.',
    note: 'The user already sees this error as a notice with what to do next. Do not repeat the error text and do not mention error codes. Say in one short sentence what you could not do, and continue with anything else you can still answer.',
  });
