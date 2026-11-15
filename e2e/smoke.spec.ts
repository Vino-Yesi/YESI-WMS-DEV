import { test, expect, type Page } from '@playwright/test';

/**
 * End-to-end smoke: first-run bootstrap → dashboard → the eight lifecycle
 * stages → session persistence across a reload.
 *
 * Requires a production build (`npm run build`) so `preview` serves `dist/`.
 *
 * There are deliberately no hard-coded credentials here. The app ships without
 * seeded logins, so the smoke test drives the same first-run flow an operator
 * meets on a fresh warehouse tablet: the login screen reports that no
 * administrator exists, offers **Bootstrap first admin**, and closes that door
 * permanently once one account exists. The password below is generated per run
 * in a throwaway browser profile and is never a real credential.
 */

const ADMIN_USERNAME = 'e2e.floor.admin';

/**
 * A per-run throwaway password that satisfies `validatePasswordStrength`:
 * ≥10 characters, at least 3 of 4 character classes, not equal to the username
 * and not a common password.
 */
function throwawayPassword(): string {
  return `E2e!Floor-${Date.now().toString(36)}Aa9`;
}

const CORE_ROUTES = [
  '/dock',
  '/inbound',
  '/qc',
  '/putaway',
  '/inventory',
  '/pick-pack',
  '/shipping',
  '/returns',
  '/cloud',
  '/guardian',
];

async function headingOf(page: Page): Promise<string> {
  return (await page.locator('h1').first().innerText()).trim();
}

/** Boots a fresh warehouse: creates the first administrator, or signs in if one exists. */
async function authenticate(page: Page, password: string): Promise<'bootstrap' | 'signin'> {
  await page.goto('/');
  // ProtectedRoute bounces an unauthenticated visitor to /login.
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });

  const heading = await headingOf(page);

  if (/First-Run Setup/i.test(heading)) {
    await expect(page.getByText(/Create the first administrator for/i)).toBeVisible();

    await page.getByPlaceholder('floor.admin').fill(ADMIN_USERNAME);
    await page.getByPlaceholder('Floor Administrator').fill('E2E Floor Administrator');
    await page.getByPlaceholder('ops@yesi.example').fill('e2e@yesi.example');
    // Bootstrap renders exactly two password fields: the new password and its
    // confirmation. `autoComplete` distinguishes them without depending on
    // DOM order.
    await page.locator('input[autocomplete="current-password"]').first().fill(password);
    await page.locator('input[autocomplete="new-password"]').first().fill(password);

    // The warehouse scope selector must be present and pre-filled: every screen
    // is bound to exactly one facility.
    const scope = page.locator('select');
    await expect(scope.first()).toBeVisible();
    expect((await scope.first().inputValue()).length).toBeGreaterThan(0);

    await page.getByRole('button', { name: /Create first administrator/i }).click();
    await expect(page).toHaveURL(/\/($|\?)/, { timeout: 30_000 });
    return 'bootstrap';
  }

  expect(heading, 'login screen heading').toMatch(/Yesi-WMS Lite|Credential Rotation/i);
  await page.getByPlaceholder('username').fill(ADMIN_USERNAME);
  await page.locator('input[autocomplete="current-password"]').first().fill(password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await expect(page).toHaveURL(/\/($|\?)/, { timeout: 30_000 });
  return 'signin';
}

test.describe('WMS smoke flow', () => {
  test('first-run bootstrap, core lifecycle routes and session persistence', async ({ page }) => {
    const password = throwawayPassword();
    const mode = await authenticate(page, password);
    expect(mode, 'a fresh browser profile has no administrator, so bootstrap is expected').toBe('bootstrap');

    // The encrypted session envelope survives a reload without re-prompting.
    await page.reload();
    await expect(page).toHaveURL(/\/($|\?)/, { timeout: 30_000 });
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);

    // Walk every operational domain: no route may hit the error boundary, and
    // each must render real content for the single warehouse in scope.
    for (const route of CORE_ROUTES) {
      await page.goto(route);
      // The PWA service worker keeps connections warm, so `networkidle` may never
      // settle: bound the wait and carry on regardless.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
      const body = await page.locator('main, body').first().innerText();
      expect(body.length, `${route} rendered no content`).toBeGreaterThan(20);
    }

    // Guardian Ops Center: resolve an active scenario when one is offered.
    await page.goto('/guardian');
    const resolveBtn = page.getByRole('button', { name: /resolve|auto|apply/i }).first();
    if (await resolveBtn.count()) {
      await resolveBtn.click();
      await page.waitForTimeout(500);
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }

    // Density toggle in the top bar.
    await page.goto('/');
    const densityBtn = page
      .locator('header button[title*="density" i], header button[title*="compact" i], header button[title*="comfortable" i]')
      .first();
    if (await densityBtn.count()) {
      await densityBtn.click();
      await page.waitForTimeout(200);
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }
  });
});
