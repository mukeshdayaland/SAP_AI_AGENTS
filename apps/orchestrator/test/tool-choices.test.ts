import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack } from './harness.js';

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const user = { id: 'x', displayName: 'X', tenantId: 't', roles: ['AI_USER' as const] };

async function guideTool(agentId: string) {
  const tools = await stack.services.mcp.listTools('DEV');
  const agent = stack.services.agents.resolve(user, agentId);
  return stack.services.agents.toolsFor(agent, tools, user).find((t) => t.name === 'shared_showFioriGuide');
}

const guides = (tool: Awaited<ReturnType<typeof guideTool>>) => (tool!.inputSchema.properties as { guide: { enum: string[] } }).guide.enum;

describe('Fiori guides per agent', () => {
  it('offers each agent only the guides of its own area', async () => {
    const fico = await guideTool('fico');
    expect(guides(fico)).toEqual(['credit-decision', 'invoice-release', 'supplier-items', 'customer-items', 'journal-entry']);
    expect(fico!.description).toContain('"journal-entry" (Manage Journal Entries)');
    expect(fico!.description).not.toContain('sales-order-complete');
    expect(fico!.description).not.toContain('goods-receipt-post');

    expect(guides(await guideTool('mm'))).toEqual(['purchase-order-change', 'goods-receipt-post', 'invoice-release']);
    expect(guides(await guideTool('sd'))).toEqual(['sales-order-complete', 'credit-decision', 'delivery-goods-issue']);
  });

  it('keeps the full list on the MCP server for other clients', async () => {
    const tool = (await stack.services.mcp.listTools('DEV')).find((t) => t.name === 'shared_showFioriGuide')!;
    expect(tool.choices?.options).toHaveLength(9);
    expect(tool.description).toContain('sales-order-complete');
    expect(tool.description).toContain('journal-entry');
  });
});
