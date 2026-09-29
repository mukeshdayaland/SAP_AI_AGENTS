import { inflateRawSync } from 'node:zlib';

/**
 * Content-based file type detection and text extraction. The browser's
 * declared MIME type is never trusted: the extension must be allowed AND the
 * bytes must match that type's signature.
 */

export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'png' | 'jpg';

export const MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
};

const EXT: Record<string, FileKind> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', csv: 'csv', txt: 'txt', png: 'png', jpg: 'jpg', jpeg: 'jpg' };

export function kindFromExtension(fileName: string): FileKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return (ext && EXT[ext]) || null;
}

const startsWith = (buf: Buffer, sig: number[]) => sig.every((b, i) => buf[i] === b);

/** Minimal ZIP central-directory reader (no ZIP64, no encryption) — enough for OOXML. */
export function readZipEntries(buf: Buffer, maxEntries = 2_000): Map<string, { offset: number; method: number; compressedSize: number }> {
  const entries = new Map<string, { offset: number; method: number; compressedSize: number }>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return entries;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < Math.min(count, maxEntries) && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), { offset, method, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf: Buffer, entry: { offset: number; method: number; compressedSize: number }, maxBytes = 20 * 1024 * 1024): string {
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('Bad local header');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  // maxOutputLength guards against decompression bombs.
  const out = entry.method === 0 ? data : inflateRawSync(data, { maxOutputLength: maxBytes });
  return out.toString('utf8');
}

export function detectKind(buf: Buffer): FileKind | 'zip' | 'text' | null {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const entries = readZipEntries(buf);
    if (entries.has('word/document.xml')) return 'docx';
    if (entries.has('xl/workbook.xml')) return 'xlsx';
    return 'zip';
  }
  if (!buf.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, 64 * 1024));
      return 'text';
    } catch {
      return null;
    }
  }
  return null;
}

/** True when the bytes are consistent with the claimed kind. */
export function contentMatches(claimed: FileKind, detected: ReturnType<typeof detectKind>): boolean {
  if (claimed === 'csv' || claimed === 'txt') return detected === 'text';
  return claimed === detected;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const MAX_TEXT = 200_000;

/** Extracts plain text for model context. Returns undefined for binary formats without an extractor. */
export function extractText(kind: FileKind, buf: Buffer): string | undefined {
  switch (kind) {
    case 'txt':
    case 'csv':
      return buf.toString('utf8').slice(0, MAX_TEXT);
    case 'docx': {
      const entries = readZipEntries(buf);
      const doc = entries.get('word/document.xml');
      if (!doc) return undefined;
      const xml = readZipEntry(buf, doc);
      return decodeXml(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, ''))
        .replace(/\n{3,}/g, '\n\n')
        .slice(0, MAX_TEXT);
    }
    case 'xlsx': {
      const entries = readZipEntries(buf);
      const shared = entries.get('xl/sharedStrings.xml');
      const strings = shared ? [...readZipEntry(buf, shared).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXml(m[1]!.replace(/<[^>]+>/g, ''))) : [];
      const sheets = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort().slice(0, 5);
      const out: string[] = [];
      for (const name of sheets) {
        out.push(`# ${name.replace(/^xl\/worksheets\//, '').replace('.xml', '')}`);
        const xml = readZipEntry(buf, entries.get(name)!);
        for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
          const cells = [...row[1]!.matchAll(/<c([^>]*?)(?:\/>|>((?:(?!<\/c>)[\s\S])*)<\/c>)/g)].map(([, attrs, inner]) => {
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner ?? '')?.[1] ?? decodeXml((inner ?? '').replace(/<[^>]+>/g, ''));
            return /t="s"/.test(attrs ?? '') ? (strings[Number(v)] ?? '') : decodeXml(v);
          });
          out.push(cells.join('\t'));
          if (out.length > 5_000) break;
        }
      }
      return out.join('\n').slice(0, MAX_TEXT);
    }
    default:
      // PDF and images: plug a TextExtractor (e.g. pdf.js, SAP Document Information Extraction) here.
      return undefined;
  }
}
