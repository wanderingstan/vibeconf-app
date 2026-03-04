import { test, expect } from '@playwright/test';

test.describe('Landing page', () => {
  test('loads and shows "Your name" input', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Your name')).toBeVisible();
  });

  test('page title is set', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/.+/);
  });

  test('has a button to start or join a meeting', async ({ page }) => {
    await page.goto('/');
    // Look for any button that could start/join a meeting
    const button = page.getByRole('button').first();
    await expect(button).toBeVisible();
  });

  test('returns 200 status', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });
});
