import type { ConversationDetail, ConversationSummary, Feedback, MessageDTO } from '@prowess/contracts';
import type { AuditTrail } from '../audit/audit.js';
import type { AuthContext } from '../auth/types.js';
import { AppError } from '../errors/app-error.js';
import type { Owner, Store } from '../persistence/types.js';
import { toMessageDTO, toSummary } from './mappers.js';

const ownerOf = (auth: AuthContext): Owner => ({ userId: auth.user.id, tenantId: auth.user.tenantId });

/** Conversation history. Every operation is scoped to the caller at the storage layer. */
export class ConversationService {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditTrail,
  ) {}

  async list(auth: AuthContext, limit = 100): Promise<ConversationSummary[]> {
    return (await this.store.conversations.list(ownerOf(auth), Math.min(limit, 200))).map(toSummary);
  }

  async get(auth: AuthContext, id: string): Promise<ConversationDetail> {
    const conversation = await this.store.conversations.get(ownerOf(auth), id);
    if (!conversation) throw AppError.notFound('Conversation');
    const messages = await this.store.messages.list(id);
    return { ...toSummary(conversation), messages: messages.map((m): MessageDTO => toMessageDTO(m, auth.user)) };
  }

  async rename(auth: AuthContext, id: string, title: string): Promise<ConversationSummary> {
    const owner = ownerOf(auth);
    if (!(await this.store.conversations.update(owner, id, { title }))) throw AppError.notFound('Conversation');
    return toSummary((await this.store.conversations.get(owner, id))!);
  }

  async delete(auth: AuthContext, id: string): Promise<void> {
    const owner = ownerOf(auth);
    if (!(await this.store.conversations.delete(owner, id))) throw AppError.notFound('Conversation');
    this.audit.record({ type: 'CONVERSATION_DELETED', ...owner, status: 'success', details: { conversationId: id } });
  }

  async feedback(auth: AuthContext, conversationId: string, messageId: string, rating: Feedback, comment?: string): Promise<void> {
    const conversation = await this.store.conversations.get(ownerOf(auth), conversationId);
    if (!conversation) throw AppError.notFound('Conversation');
    const ok = await this.store.messages.update(conversationId, messageId, { feedback: rating, ...(comment && { feedbackComment: comment }) });
    if (!ok) throw AppError.notFound('Message');
  }
}
