import { extractText, getDocumentProxy } from 'unpdf';
import { SapError } from '../sap/model.js';
import { documentText, type DocumentExtractor, type ExtractedDocument } from './document-ai.js';

/**
 * Text of a mail attachment, for the model to read. The declared content type
 * is never trusted: the kind is taken from the bytes. PDFs are read with pdf.js
 * (no scripts, no rendering). Scanned PDFs and images carry no text: they go to
 * SAP Document AI when it is configured, which recognizes the invoice fields.
 */

export type AttachmentKind = 'pdf' | 'text' | 'image';

/** Longest attachment text handed to the model. */
export const MAX_ATTACHMENT_TEXT = 20_000;
const MAX_PAGES = 30;

export interface AttachmentText {
  kind: AttachmentKind;
  text: string;
  pages?: number;
  truncated: boolean;
  /** Set when SAP Document AI read the file: the invoice fields it recognized, with their confidence. */
  extracted?: ExtractedDocument;
}

const IMAGE_TYPES: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x49, 0x49, 0x2a, 0x00], 'image/tiff'],
  [[0x4d, 0x4d, 0x00, 0x2a], 'image/tiff'],
];

function kindOf(bytes: Buffer): { kind: AttachmentKind; contentType: string } | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', contentType: 'application/pdf' };
  const image = IMAGE_TYPES.find(([sig]) => sig.every((b, i) => bytes[i] === b));
  if (image) return { kind: 'image', contentType: image[1] };
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 64 * 1024));
    return { kind: 'text', contentType: 'text/plain' };
  } catch {
    return null;
  }
}

const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export async function attachmentText(name: string, bytes: Buffer, documents?: DocumentExtractor): Promise<AttachmentText> {
  const detected = kindOf(bytes);
  if (!detected) throw new SapError('NOT_SUPPORTED', `"${name}" is not a PDF, image or text file, so it cannot be read here.`);
  const { kind, contentType } = detected;

  let text = '';
  let pages: number | undefined;
  if (kind === 'pdf') {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
      pages = pdf.numPages;
      if (pages > MAX_PAGES) throw new SapError('BUSINESS_RULE', `"${name}" has ${pages} pages; at most ${MAX_PAGES} are read.`);
      text = (await extractText(pdf, { mergePages: true })).text;
    } catch (err) {
      if (err instanceof SapError) throw err;
      throw new SapError('INVALID_INPUT', `"${name}" could not be read as a PDF (${(err as Error).message.slice(0, 120)}).`);
    }
  } else if (kind === 'text') {
    text = bytes.toString('utf8');
  }

  const clean = tidy(text);
  if (clean) return { kind, text: clean.slice(0, MAX_ATTACHMENT_TEXT), ...(pages !== undefined && { pages }), truncated: clean.length > MAX_ATTACHMENT_TEXT };

  // A scan or a photo: only OCR can read it.
  if (!documents) {
    throw new SapError('NOT_SUPPORTED', `"${name}" contains no text; it is probably a scanned image. Ask the supplier for a PDF with text, or enter the invoice by hand.`);
  }
  const extracted = await documents.extractInvoice(name, contentType, bytes);
  const read = documentText(extracted);
  if (!read) throw new SapError('NOT_SUPPORTED', `No invoice fields could be recognized in "${name}". Enter the invoice by hand.`);
  return { kind, text: read.slice(0, MAX_ATTACHMENT_TEXT), ...(pages !== undefined && { pages }), truncated: read.length > MAX_ATTACHMENT_TEXT, extracted };
}
