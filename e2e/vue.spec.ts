import { test, expect } from '@playwright/test'

// See here how to get started:
// https://playwright.dev/docs/intro
test('shows the main window', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.app-window .title-bar-text')).toContainText('ntyonenote')
})
