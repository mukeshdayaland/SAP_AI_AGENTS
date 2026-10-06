import { expect, test } from '@playwright/test';

test.describe('Prowess AI workspace', () => {
  test('FICO invoice analysis → human-confirmed payment block release', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /How can I help you today\?/ })).toBeVisible();

    // Starter actions come from server configuration.
    await page.getByRole('button', { name: /Analyze an invoice/ }).click();

    const invoice = page.getByRole('region', { name: 'Supplier invoice 5100012345' }).first();
    await expect(invoice).toBeVisible();
    await expect(invoice.getByText('Payment blocked')).toBeVisible();
    await expect(page.getByText('Verification issues').first()).toBeVisible();
    await expect(page.getByText(/blocked for payment/).first()).toBeVisible();
    await expect(page.getByText('Mock data').first()).toBeVisible();

    // A write is proposed, not executed.
    await page.getByRole('button', { name: 'Release payment block' }).click();
    const card = page.getByRole('group', { name: 'Confirm SAP action' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Release invoice payment block')).toBeVisible();
    await expect(card.getByText(/eligible for the next payment run/)).toBeVisible();

    await card.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(card.getByText('Completed')).toBeVisible();
    await expect(page.getByText(/was released\. Status is now/)).toBeVisible();

    // Conversation persisted and listed in the sidebar.
    await expect(page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: 'Why is invoice 5100012345 blocked?', exact: true })).toBeVisible();
  });

  test('keyboard: Enter sends and Shift+Enter adds a line; tools are scoped to the agent', async ({ page }) => {
    await page.goto('/');
    // Tools are scoped per agent: PM tools belong to MM.
    await page.getByLabel('Agent').selectOption('mm');
    const input = page.getByLabel(/Message/);
    await input.fill('Analyze maintenance history');
    await input.press('Shift+Enter');
    await input.pressSequentially('for equipment 20001234.');
    await expect(input).toHaveValue('Analyze maintenance history\nfor equipment 20001234.');
    await input.press('Enter');
    await expect(page.getByRole('region', { name: /Maintenance history · 20001234/ })).toBeVisible();
    await expect(page.getByRole('article', { name: 'MM response' })).toBeVisible();
  });

  test('theme can be switched and persists', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Dark' }).click();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  });
});
