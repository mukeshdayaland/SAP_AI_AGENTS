import { expect, test } from '@playwright/test';

/**
 * The Arabic interface. The offline mock model only understands English
 * questions, so the question is typed in English; everything the workspace
 * draws around the answer must still be Arabic and right to left.
 */
test.describe('Arabic interface', () => {
  test('switches to Arabic in Settings, mirrors the layout and remembers the choice', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /How can I help you today\?/ })).toBeVisible();

    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'العربية' }).click();
    await page.keyboard.press('Escape');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { name: /كيف يمكنني مساعدتك اليوم؟/ })).toBeVisible();
    // Starter cards come from the server in Arabic once the language changes.
    await expect(page.getByRole('button', { name: /تحليل فاتورة/ })).toBeVisible();

    // The choice is applied before paint on the next visit.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: /كيف يمكنني مساعدتك اليوم؟/ })).toBeVisible();
  });

  test('draws SAP cards, progress and actions in Arabic', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('prowess-lang', 'ar'));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const input = page.getByLabel(/رسالة إلى/);
    // Not the English test's question, so the two conversations are told apart in the sidebar.
    await input.fill('Check why invoice 5100012345 is blocked.');
    await input.press('Enter');

    const invoice = page.getByRole('region', { name: 'فاتورة مورد 5100012345' }).first();
    await expect(invoice).toBeVisible();
    await expect(invoice.getByText('الدفع موقوف')).toBeVisible();
    await expect(invoice.getByText('مشكلات التحقق')).toBeVisible();
    await expect(invoice.getByRole('button', { name: 'تحليل المورد' })).toBeVisible();
    await expect(page.getByText(/استُخدمت/).first()).toBeVisible();
    await expect(page.getByText('بيانات تجريبية').first()).toBeVisible();
    await expect(page).toHaveTitle(/WTCO AI|Prowess AI/);
  });
});
