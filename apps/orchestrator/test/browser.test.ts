import type { BrowserAction, BrowserPage, StreamEvent } from '@prowess/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserBridge, toBrowserAction } from '../src/browser/browser-bridge.js';
import { startStack, USERS } from './harness.js';

const PAGE: BrowserPage = {
  title: 'change sales order 648',
  location: '/sap/bc/ui2/flp#SalesOrder-change?SalesOrder=648',
  messages: [],
  elements: [
    { ref: 'e1', role: 'textbox', label: 'Sales order', value: '648', disabled: true },
    { ref: 'e2', role: 'textbox', label: 'Payment terms', value: '' },
    { ref: 'e3', role: 'button', label: 'Save' },
  ],
};

describe('browser bridge', () => {
  const owner = { userId: 'u1', tenantId: 't1' };
  const read: BrowserAction = { id: 'b_0123456789abcdef', kind: 'read' };

  it('hands the result to the request it answers, and only from the user it was sent to', async () => {
    const bridge = new BrowserBridge();
    const sent: BrowserAction[] = [];
    const pending = bridge.request(owner, read, (a) => sent.push(a), new AbortController().signal);
    expect(sent).toEqual([read]);
    expect(bridge.resolve({ userId: 'someone-else', tenantId: 't1' }, { id: read.id, ok: true })).toBe(false);
    expect(bridge.resolve(owner, { id: read.id, ok: true, page: PAGE })).toBe(true);
    expect(await pending).toEqual({ id: read.id, ok: true, page: PAGE });
    // An answer that comes twice has nothing left to answer.
    expect(bridge.resolve(owner, { id: read.id, ok: true })).toBe(false);
  });

  it('ends a request the user stopped', async () => {
    const bridge = new BrowserBridge();
    const stop = new AbortController();
    const pending = bridge.request(owner, read, () => undefined, stop.signal);
    stop.abort();
    expect(await pending).toMatchObject({ ok: false, message: 'The request was stopped.' });
  });

  it('takes only element names the page gave out', () => {
    expect(toBrowserAction('fiori_click', { ref: 'e3', note: 'Save the order.' })).toMatchObject({ kind: 'click', ref: 'e3', note: 'Save the order.' });
    expect(toBrowserAction('fiori_type', { ref: 'e2', text: '0001', note: '' })).toMatchObject({ kind: 'type', ref: 'e2', text: '0001' });
    expect(toBrowserAction('fiori_click', { ref: '#save', note: '' })).toBeNull();
    expect(toBrowserAction('fiori_type', { ref: 'e2', note: '' })).toBeNull();
    expect(toBrowserAction('fiori_read', {})).toMatchObject({ kind: 'read' });
  });
});

describe('an agent working in the Fiori pane', () => {
  let stack: Awaited<ReturnType<typeof startStack>>;
  beforeAll(async () => {
    stack = await startStack({ fioriLaunchpad: '/sap/bc/ui2/flp' });
  });
  afterAll(() => stack.stop());

  /** Streams a chat turn and answers each action the way the pane would. */
  async function chat(message: string, conversationId?: string) {
    const res = await fetch(`${stack.base}/api/v1/chat`, {
      method: 'POST',
      headers: { 'x-prowess-dev-user': USERS.jordan, 'x-requested-with': 'prowess', 'content-type': 'application/json' },
      body: JSON.stringify({ message, agent: 'sd', ...(conversationId && { conversationId }) }),
    });
    const events: StreamEvent[] = [];
    const foreign: number[] = [];
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6);
        buffer = buffer.slice(end + 2);
        if (!data) continue;
        const event = JSON.parse(data) as StreamEvent;
        events.push(event);
        if (event.type !== 'browser.action') continue;
        const page = event.action.kind === 'click' ? { ...PAGE, messages: ['Sales order 648 was saved.'] } : PAGE;
        const result = { id: event.action.id, ok: true, ...(event.action.kind !== 'point' && { page }) };
        foreign.push((await stack.request('POST', '/api/v1/browser/results', USERS.alex, result)).status);
        expect((await stack.request('POST', '/api/v1/browser/results', USERS.jordan, result)).status).toBe(204);
      }
    }
    return { events, foreign, actions: events.flatMap((e) => (e.type === 'browser.action' ? [e.action] : [])) };
  }

  it('opens the app, reads the page and points at what is missing', async () => {
    const { events, actions, foreign } = await chat('Guide me in Fiori to complete sales order 648');
    const guide = events.flatMap((e) => (e.type === 'component' && e.component.type === 'fiori_guide' ? [e.component.data] : []))[0];
    expect(guide).toMatchObject({ url: '/sap/bc/ui2/flp#SalesOrder-change?SalesOrder=648', embed: true });
    expect(actions).toMatchObject([{ kind: 'read' }, { kind: 'point', ref: 'e2', note: 'Payment terms is empty. Enter the value here, then choose Save.' }]);
    // Another user cannot answer for this browser.
    expect(foreign).toEqual([404, 404]);
    expect(events.at(-1)).toMatchObject({ type: 'message.complete', status: 'complete' });
    // Newest first.
    expect(stack.auditBuffer.events.filter((e) => e.type === 'BROWSER_ACTION').map((e) => [e.tool, e.status])).toEqual([
      ['fiori_point', 'success'],
      ['fiori_read', 'success'],
    ]);
  });

  it('types the value the user gave, clicks Save and reports what SAP answered', async () => {
    const first = await chat('Guide me in Fiori to complete sales order 648');
    const conversationId = first.events.flatMap((e) => (e.type === 'message.start' ? [e.conversationId] : []))[0]!;
    const { events, actions } = await chat('Enter 0001 as payment terms and save', conversationId);
    expect(actions).toMatchObject([{ kind: 'read' }, { kind: 'type', ref: 'e2', text: '0001' }, { kind: 'click', ref: 'e3' }]);
    const answer = events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('');
    expect(answer).toBe('SAP answered: Sales order 648 was saved.');
  });

  it('refuses a result that names no action it sent', async () => {
    expect((await stack.request('POST', '/api/v1/browser/results', USERS.jordan, { id: 'b_unknownunknown', ok: true })).status).toBe(404);
    expect((await stack.request('POST', '/api/v1/browser/results', USERS.jordan, { id: 'nope', ok: true })).status).toBe(400);
  });
});
