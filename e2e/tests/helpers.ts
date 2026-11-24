/** Shared by the hosted specs: the server under test, its seeded admin and signing in. */
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

export const BASE = process.env.MIDDEN_E2E_BASE ?? 'http://127.0.0.1:18090';
export const ADMIN = { username: 'admin', password: 'e2e-admin-password' };
export const H = { 'x-midden-client': '1' };

export async function apiLogin(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const r = await request.post(`${BASE}/api/auth/login`, {
    headers: H,
    data: { username, password },
  });
  expect(r.ok()).toBeTruthy();
}

/** Ensure a user exists with a known, already-changed password. */
export async function ensureUser(
  request: APIRequestContext,
  username: string,
  password: string,
  role = 'analyst',
): Promise<void> {
  await apiLogin(request, ADMIN.username, ADMIN.password);
  const created = await request.post(`${BASE}/api/users`, {
    headers: H,
    data: { username, role, password },
  });
  if (created.status() === 409) return;
  expect(created.status()).toBe(201);
  await request.post(`${BASE}/api/auth/logout`, { headers: H });
  await apiLogin(request, username, password);
  const ch = await request.post(`${BASE}/api/auth/password`, {
    headers: H,
    data: { next: password },
  });
  expect(ch.ok()).toBeTruthy();
  await request.post(`${BASE}/api/auth/logout`, { headers: H });
}

export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE}/#/cases`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function userPage(
  browser: Browser,
  username: string,
  password: string,
): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, username, password);
  await expect(page.getByTestId('nav-cases')).toBeVisible();
  return page;
}
