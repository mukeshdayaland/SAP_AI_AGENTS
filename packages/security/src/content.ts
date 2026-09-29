/**
 * Helpers for treating model, tool and document content as untrusted data.
 */

/**
 * Wraps untrusted content in explicit delimiters before it is shown to a model.
 * Delimiter look-alikes inside the content are neutralized so the content
 * cannot "close" the block and smuggle instructions outside it.
 */
export function fenceUntrusted(kind: 'tool_result' | 'document' | 'sap_data', content: string, maxChars = 24_000): string {
  const clean = content
    .replace(/<\/?\s*untrusted[^>]*>/gi, '[removed-delimiter]')
    .slice(0, maxChars);
  const truncated = content.length > maxChars ? '\n[truncated]' : '';
  return `<untrusted kind="${kind}">\n${clean}${truncated}\n</untrusted>`;
}

/** Heuristic markers of instruction-injection attempts inside data. Used for telemetry, not as a sole control. */
const INJECTION_MARKERS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)/i,
  /disregard (the )?(system|previous) (prompt|instructions)/i,
  /you are now (in )?(developer|dan|admin) mode/i,
  /\bsystem prompt\b.*\b(reveal|print|show)\b/i,
  /\b(call|invoke|execute) (the )?tool\b/i,
  /\bgrant (me|yourself) (admin|AI_ADMIN|all) (rights|roles|access)\b/i,
];

export function detectInjectionMarkers(text: string): string[] {
  return INJECTION_MARKERS.filter((re) => re.test(text)).map((re) => re.source);
}

/** Only http(s) links to explicitly allowed hosts may be rendered as clickable links. */
export function isSafeLink(href: string, allowedHosts: readonly string[] = []): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return allowedHosts.length === 0 || allowedHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Safe file name: strips paths, control chars and anything outside a conservative set. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the intent
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'file';
}
