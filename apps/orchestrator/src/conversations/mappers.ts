import { randomBytes } from 'node:crypto';
import type { ConfirmationRequest, ConversationSummary, MessageDTO, UserProfile } from '@prowess/contracts';
import { hasRole } from '../auth/types.js';
import type { ConversationRecord, MessageRecord, PendingActionRecord } from '../persistence/types.js';

/** Opaque, unguessable identifiers (128 bits). */
export const newId = (prefix: 'c' | 'm' | 'a' | 'f' | 't' | 'r') => `${prefix}_${randomBytes(16).toString('base64url')}`;

export const canSeeTechnicalDetails = (user: UserProfile) => hasRole(user, 'AI_POWER_USER') || hasRole(user, 'AI_ADMIN');

export function titleFrom(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`;
}

export function toSummary(c: ConversationRecord): ConversationSummary {
  return { id: c.id, title: c.title, agent: c.agent, createdAt: c.createdAt, updatedAt: c.updatedAt };
}

/** Strips server-only fields and, for standard users, provider/model details. */
export function toMessageDTO(m: MessageRecord, user: UserProfile): MessageDTO {
  const technical = canSeeTechnicalDetails(user);
  const response = m.response && {
    ...m.response,
    ...(m.response.execution && {
      execution: technical
        ? m.response.execution
        : (({ provider: _p, model: _m, ...rest }) => rest)(m.response.execution),
    }),
  };
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.agent && { agent: m.agent }),
    ...(m.modelTier && { modelTier: m.modelTier }),
    createdAt: m.createdAt,
    status: m.status,
    ...(m.attachments?.length && { attachments: m.attachments }),
    ...(response && { response }),
    ...(m.feedback && { feedback: m.feedback }),
    ...(m.error && { error: m.error }),
  };
}

export function toConfirmation(a: PendingActionRecord): ConfirmationRequest {
  return {
    id: a.id,
    action: a.preview.action,
    targetSystem: a.targetSystem,
    environment: a.environment,
    businessObject: a.preview.businessObject,
    proposedChange: a.preview.proposedChange,
    impact: a.preview.impact,
    risk: a.risk,
    expiresAt: a.expiresAt,
    status: a.status,
  };
}
