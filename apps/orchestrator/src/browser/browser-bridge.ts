import { randomBytes } from 'node:crypto';
import type { BrowserAction, BrowserActionResult } from '@prowess/contracts';
import type { ToolSpec } from '@prowess/llm';
import type { Owner } from '../persistence/types.js';

/**
 * The agent's hands in the Fiori pane. These tools are not SAP calls: the
 * orchestrator sends the action down the chat stream, the user's browser
 * carries it out in the page it has open, and posts back what happened. SAP
 * sees the user's own session, so SAP authorizations apply as they do when
 * the user clicks.
 */

/** The MCP tool that opens the pane; the browser tools are offered with it. */
export const FIORI_OPEN_TOOL = 'shared_showFioriGuide';

const ref = { type: 'string', description: 'The element, as fiori_read named it, e.g. "e12".' };
const note = { type: 'string', description: 'One or two plain sentences shown to the user next to the element: what this step is and why.' };

export const BROWSER_TOOLS: ToolSpec[] = [
  {
    name: 'fiori_read',
    description:
      'Read the Fiori page the user has open in the browser pane: its fields with their values, its buttons, and the messages SAP shows. Call it after shared_showFioriGuide opened the app and before you point, type or click; the element names it returns are valid until the page changes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fiori_point',
    description: 'Move your cursor to an element and show the user a note beside it, without changing anything. Use it to explain a step the user has to do or decide themselves.',
    inputSchema: { type: 'object', properties: { ref, note }, required: ['ref', 'note'] },
  },
  {
    name: 'fiori_type',
    description: 'Type a value into a field of the page. Only values the user gave you or a tool returned; never guess one. Nothing is saved until Save is clicked. Returns the page as it is afterwards.',
    inputSchema: { type: 'object', properties: { ref, text: { type: 'string', description: 'The value to enter.' }, note }, required: ['ref', 'text', 'note'] },
  },
  {
    name: 'fiori_click',
    description:
      'Click a button, tab or link of the page. A click that saves, posts, releases or deletes is shown to the user first and happens only if they allow it. Returns the page as it is afterwards; read its messages before you say that something worked.',
    inputSchema: { type: 'object', properties: { ref, note }, required: ['ref', 'note'] },
  },
];

const KINDS: Record<string, BrowserAction['kind']> = { fiori_read: 'read', fiori_point: 'point', fiori_type: 'type', fiori_click: 'click' };

export const isBrowserTool = (name: string) => name in KINDS;

/** Builds the action from the model's arguments; null when they are not usable. */
export function toBrowserAction(tool: string, args: Record<string, unknown>): BrowserAction | null {
  const kind = KINDS[tool];
  const id = `b_${randomBytes(12).toString('base64url')}`;
  if (kind === 'read') return { id, kind };
  const target = typeof args.ref === 'string' && /^e\d{1,4}$/.test(args.ref) ? args.ref : null;
  if (!kind || !target) return null;
  const said = typeof args.note === 'string' ? args.note.slice(0, 300) : '';
  if (kind === 'type') return typeof args.text === 'string' ? { id, kind, ref: target, text: args.text.slice(0, 200), note: said } : null;
  return { id, kind, ref: target, note: said };
}

/** A click may wait for the user to allow it; everything else is answered at once. */
const WAIT_MS: Record<BrowserAction['kind'], number> = { read: 20_000, point: 20_000, type: 20_000, click: 120_000 };

interface Pending {
  userId: string;
  tenantId: string;
  settle: (result: BrowserActionResult) => void;
}

/** Matches each action sent to a browser with the result that browser posts back. */
export class BrowserBridge {
  private readonly pending = new Map<string, Pending>();

  /** Sends the action and waits for the pane. Never rejects: no answer is a failed action. */
  request(owner: Owner, action: BrowserAction, send: (action: BrowserAction) => void, signal: AbortSignal): Promise<BrowserActionResult> {
    return new Promise((resolve) => {
      const finish = (result: BrowserActionResult) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(action.id);
        resolve(result);
      };
      const onAbort = () => finish({ id: action.id, ok: false, message: 'The request was stopped.' });
      const timer = setTimeout(() => finish({ id: action.id, ok: false, message: 'The browser pane did not answer. It may be closed.' }), WAIT_MS[action.kind]);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(action.id, { ...owner, settle: finish });
      send(action);
    });
  }

  /** Takes a result from the browser. Only the user the action was sent to can answer it. */
  resolve(owner: Owner, result: BrowserActionResult): boolean {
    const waiting = this.pending.get(result.id);
    if (!waiting || waiting.userId !== owner.userId || waiting.tenantId !== owner.tenantId) return false;
    waiting.settle(result);
    return true;
  }
}
