import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttachmentRef } from '@prowess/contracts';
import type { Logger } from '@prowess/observability';
import { sanitizeFileName } from '@prowess/security';
import type { AuditTrail } from '../audit/audit.js';
import type { AuthContext } from '../auth/types.js';
import type { OrchestratorConfig } from '../config/env.js';
import { newId } from '../conversations/mappers.js';
import { AppError } from '../errors/app-error.js';
import type { Store } from '../persistence/types.js';
import { MIME, contentMatches, detectKind, extractText, kindFromExtension } from './inspect.js';
import type { MalwareScanner } from './scanner.js';

/**
 * Upload lifecycle: validate → scan → store (private temp storage) → extract
 * text → expire. Stored files are only ever read back as extracted text for
 * the owner's own prompts; they are never served to browsers.
 */
export class FileService {
  constructor(
    private readonly deps: { store: Store; scanner: MalwareScanner; audit: AuditTrail; logger: Logger; config: OrchestratorConfig['uploads'] },
  ) {}

  async upload(auth: AuthContext, originalName: string, data: Buffer): Promise<AttachmentRef> {
    const { config, scanner, store, audit, logger } = this.deps;
    if (!config.enabled) throw AppError.forbidden('File uploads are disabled.');
    const owner = { userId: auth.user.id, tenantId: auth.user.tenantId };

    const fileName = sanitizeFileName(originalName);
    const kind = kindFromExtension(fileName);
    if (!kind || !config.allowedTypes.includes(kind === 'jpg' ? 'jpg' : kind)) {
      throw AppError.validation(`This file type is not supported. Allowed: ${config.allowedTypes.join(', ')}.`);
    }
    if (data.length === 0) throw AppError.validation('The file is empty.');
    if (data.length > config.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', `Files must be smaller than ${Math.round(config.maxBytes / 1_048_576)} MB.`, 'VALIDATION');
    if (!contentMatches(kind, detectKind(data))) {
      audit.record({ type: 'SECURITY_DENIAL', ...owner, status: 'denied', details: { reason: 'file_content_mismatch', kind } });
      throw AppError.validation('The file content does not match its type.');
    }

    let scan;
    try {
      scan = await scanner.scan(data);
    } catch (err) {
      logger.error('files.scan_failed', { error: err as Error });
      throw new AppError('SCAN_UNAVAILABLE', 'The file could not be checked for malware. Please try again later.', 'INTERNAL', true);
    }
    if (!scan.clean) {
      audit.record({ type: 'SECURITY_DENIAL', ...owner, status: 'denied', details: { reason: 'malware_detected', signature: scan.signature ?? 'unknown' } });
      throw AppError.validation('The file was rejected by the malware scanner.');
    }

    let extractedText: string | undefined;
    try {
      extractedText = extractText(kind, data);
    } catch (err) {
      logger.warn('files.extract_failed', { kind, error: (err as Error).message });
    }

    const id = newId('f');
    await mkdir(config.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(config.dir, id), data, { mode: 0o600 });
    const now = Date.now();
    await store.attachments.create({
      id,
      ...owner,
      fileName,
      mimeType: MIME[kind],
      sizeBytes: data.length,
      storageKey: id,
      ...(extractedText && { extractedText }),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.retentionHours * 3_600_000).toISOString(),
    });
    audit.record({ type: 'FILE_UPLOADED', ...owner, status: 'success', details: { fileId: id, kind, sizeBytes: data.length, scanner: scanner.name } });
    return { id, fileName, mimeType: MIME[kind], sizeBytes: data.length };
  }

  async delete(auth: AuthContext, id: string): Promise<void> {
    const owner = { userId: auth.user.id, tenantId: auth.user.tenantId };
    const a = await this.deps.store.attachments.get(owner, id);
    if (!a) throw AppError.notFound('File');
    await rm(join(this.deps.config.dir, a.storageKey), { force: true });
    await this.deps.store.attachments.delete(owner, id);
  }

  /** Deletes expired uploads (bytes and metadata). */
  async purgeExpired(): Promise<number> {
    const expired = await this.deps.store.attachments.listExpired(new Date().toISOString());
    for (const a of expired) {
      await rm(join(this.deps.config.dir, a.storageKey), { force: true });
      await this.deps.store.attachments.deleteById(a.id);
    }
    return expired.length;
  }
}
