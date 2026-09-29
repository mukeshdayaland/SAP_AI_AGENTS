import type { ErrorCategory, PublicError } from '@prowess/contracts';
import { ProviderError } from '@prowess/llm';
import { M, currentContext, newCorrelationId, referenceFromCorrelationId } from '@prowess/observability';

const STATUS: Record<ErrorCategory, number> = {
  VALIDATION: 400,
  AUTHENTICATION: 401,
  AUTHORIZATION: 403,
  NOT_FOUND: 404,
  RATE_LIMIT: 429,
  QUOTA: 429,
  MODEL_PROVIDER: 502,
  TOOL: 502,
  SAP: 502,
  CONFIGURATION: 503,
  INTERNAL: 500,
};

/**
 * The application's single error type. `message` must be safe to show end
 * users; diagnostic detail belongs in `internal` (logged, never returned).
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly category: ErrorCategory,
    readonly retryable = false,
    readonly internal?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return STATUS[this.category];
  }

  static notFound(what = 'The requested item') {
    return new AppError('NOT_FOUND', `${what} was not found.`, 'NOT_FOUND');
  }
  static forbidden(message = 'You are not permitted to perform this action.') {
    return new AppError('FORBIDDEN', message, 'AUTHORIZATION');
  }
  static unauthenticated() {
    return new AppError('UNAUTHENTICATED', 'Please sign in to continue.', 'AUTHENTICATION');
  }
  static validation(message: string) {
    return new AppError('VALIDATION_FAILED', message, 'VALIDATION');
  }
}

/** Converts anything thrown into an AppError without leaking internals. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case 'rate_limited':
        return new AppError('LLM_RATE_LIMITED', 'The AI service is busy right now. Please try again in a moment.', 'MODEL_PROVIDER', true, err);
      case 'timeout':
      case 'unavailable':
      case 'circuit_open':
        return new AppError('LLM_UNAVAILABLE', 'The AI service is temporarily unavailable. Please try again.', 'MODEL_PROVIDER', true, err);
      case 'content_filter':
        return new AppError('LLM_CONTENT_FILTERED', 'The request was blocked by the AI content policy.', 'MODEL_PROVIDER', false, err);
      case 'configuration':
        return new AppError('LLM_NOT_CONFIGURED', 'No AI model is configured for this request.', 'CONFIGURATION', false, err);
      case 'aborted':
        return new AppError('ABORTED', 'The request was cancelled.', 'VALIDATION', false, err);
      default:
        return new AppError('LLM_FAILED', 'The AI service could not process this request.', 'MODEL_PROVIDER', false, err);
    }
  }
  if ((err as { validation?: unknown }).validation) {
    return AppError.validation('The request is invalid.');
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (status === 413) return new AppError('PAYLOAD_TOO_LARGE', 'The upload is too large.', 'VALIDATION');
  if (status && status >= 400 && status < 500) return AppError.validation('The request is invalid.');
  return new AppError('INTERNAL', 'Something went wrong on our side.', 'INTERNAL', true, err);
}

export function toPublicError(err: AppError): PublicError {
  const correlationId = currentContext()?.correlationId ?? newCorrelationId();
  M.errors().inc({ category: err.category, code: err.code });
  return {
    code: err.code,
    message: err.message,
    correlationId,
    reference: referenceFromCorrelationId(correlationId),
    retryable: err.retryable,
    category: err.category,
  };
}
