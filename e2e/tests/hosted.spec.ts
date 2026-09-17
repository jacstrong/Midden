import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCAN_XML = resolve(import.meta.dirname, '../../packages/core/fixtures/nmap/lab-small.xml');

const BASE = process.env.MIDDEN_E2E_BASE ?? 'http://127.0.0.1:18090';
const ADMIN = { username: 'admin', password: 'e2e-admin-password' };
const H = { 'x-midden-client': '1' };

async function apiLogin(
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
async function ensureUser(
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

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE}/#/cases`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function userPage(browser: Browser, username: string, password: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, username, password);
  await expect(page.getByTestId('nav-cases')).toBeVisible();
  return page;
}

test.describe('hosted collaboration', () => {
  test.beforeAll(async ({ request }) => {
    await ensureUser(request, 'ann', 'ann-password-123');
    await ensureUser(request, 'bob', 'bob-password-123');
    await ensureUser(request, 'vic', 'vic-password-123', 'viewer');
  });

  test('admin signs in, must change the seeded password, then manages users', async ({ page }) => {
    await signIn(page, ADMIN.username, ADMIN.password);
    // first login forces a password change; setting the same value keeps later tests valid
    const pw = page.getByTestId('password-form');
    await expect(pw.or(page.getByTestId('nav-users'))).toBeVisible();
    if (await pw.isVisible()) {
      await page.getByLabel('New password', { exact: true }).fill(ADMIN.password);
      await page.getByLabel('New password again').fill(ADMIN.password);
      await page.getByRole('button', { name: 'Save password' }).click();
    }
    await expect(page.getByTestId('nav-users')).toBeVisible();
    await page.getByTestId('nav-users').click();
    await expect(page.getByTestId('user-row')).toHaveCount(4);
    await page.locator('#nuName').fill('carl');
    await page.locator('#nuRole').selectOption('viewer');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('temp-password')).toContainText('carl');
    await expect(page.getByTestId('user-row')).toHaveCount(5);
  });

  test('two analysts edit one case live, see each other, get conflict notices, and revert from history', async ({
    browser,
  }) => {
    const ann = await userPage(browser, 'ann', 'ann-password-123');
    const bob = await userPage(browser, 'bob', 'bob-password-123');

    // ann creates a case
    await ann.locator('#ncName').fill('Live Collab');
    await ann.locator('#ncNumber').fill('IR-E2E');
    await ann.getByRole('button', { name: 'Create' }).click();
    await expect(ann).toHaveURL(/#\/c\/case_[^/]+\/graph$/);
    const caseUrl = ann.url();
    await expect(ann.getByTestId('presence')).toContainText('A');

    // bob opens the same case from the list
    await bob.getByTestId('nav-cases').click();
    await bob.getByTestId('case-row').filter({ hasText: 'Live Collab' }).click();
    await expect(bob).toHaveURL(caseUrl);
    await expect(bob.locator('#caseName')).toHaveValue('Live Collab');
    await expect(ann.getByTestId('presence').locator('.avatar')).toHaveCount(2);

    // ann adds a host; bob sees it without reloading
    await ann.keyboard.press('h');
    await ann.getByRole('dialog').getByLabel('Hostname', { exact: true }).fill('DC-01');
    await ann.getByRole('dialog').getByLabel('IP address(es)').fill('10.0.0.5');
    await ann.getByTestId('host-save').click();
    await expect(bob.getByTestId('st-hosts')).toHaveText('1');

    // bob adds an event; ann sees it
    await bob.keyboard.press('n');
    const bd = bob.getByRole('dialog');
    await bd.getByLabel('Timestamp', { exact: true }).fill('2026-07-14 09:00:00');
    await bd.getByLabel('Activity', { exact: true }).fill('Suspicious logon');
    await bob.getByTestId('event-save').click();
    await expect(ann.getByTestId('st-events')).toHaveText('1');
    await expect(ann.getByTestId('graph-row')).toContainText('Suspicious logon');

    // same-field conflict: both open the host; bob saves status first, then ann saves status
    await ann.getByTestId('tab-hosts').click();
    await bob.getByTestId('tab-hosts').click();
    await ann.getByTestId('host-card').click();
    await bob.getByTestId('host-card').click();
    await bob.getByRole('dialog').getByLabel('Status').selectOption('compromised');
    await bob.getByTestId('host-save').click();
    // ann's open editor is told that bob changed the field
    await expect(ann.getByTestId('remote-changed')).toContainText('bob changed status');
    await ann.getByRole('dialog').getByLabel('Status').selectOption('contained');
    await ann.getByTestId('host-save').click();
    await expect(
      ann.getByTestId('toast').filter({ hasText: 'bob also changed status' }),
    ).toBeVisible();
    await expect(bob.getByTestId('host-card')).toContainText('Contained');

    // history shows the chain and reverts the last change
    await ann.getByTestId('tab-history').click();
    const rows = ann.getByTestId('history-row');
    await expect(rows.first()).toContainText('ann');
    await expect(rows.first()).toContainText('contained');
    await rows.first().getByTestId('revert').click();
    await ann.getByRole('alertdialog').getByRole('button', { name: 'Revert' }).click();
    await expect(rows.first()).toContainText('Reverted change');
    await expect(bob.getByTestId('host-card')).toContainText('Compromised');

    // a viewer can read but not edit
    const vic = await userPage(browser, 'vic', 'vic-password-123');
    await vic.goto(caseUrl);
    await expect(vic.getByTestId('banner-readonly')).toBeVisible();
    await expect(vic.getByTestId('btn-new-event')).toHaveCount(0);
    await vic.keyboard.press('n');
    await expect(vic.getByRole('dialog')).toHaveCount(0);
    await expect(vic.getByTestId('st-hosts')).toHaveText('1');

    await ann.context().close();
    await bob.context().close();
    await vic.context().close();
  });

  test('a scan uploaded by one analyst appears for the other, and promotion overlays the map', async ({
    browser,
  }) => {
    const ann = await userPage(browser, 'ann', 'ann-password-123');
    const bob = await userPage(browser, 'bob', 'bob-password-123');
    await ann.locator('#ncName').fill('Terrain Case');
    await ann.getByRole('button', { name: 'Create' }).click();
    await expect(ann).toHaveURL(/#\/c\//);
    const url = ann.url();
    await bob.goto(url);
    await expect(bob.locator('#caseName')).toHaveValue('Terrain Case');

    // ann uploads; the server parses it and broadcasts the result to both clients
    await ann.getByTestId('tab-scans').click();
    await ann.getByTestId('scan-file-input').setInputFiles(SCAN_XML);
    await expect(ann.getByTestId('terrain-row')).toHaveCount(6, { timeout: 20_000 });

    // bob sees the same scan without reloading
    await bob.getByTestId('tab-scans').click();
    await expect(bob.getByTestId('scan-tab')).toHaveCount(1);
    await expect(bob.getByTestId('terrain-row')).toHaveCount(6);
    await expect(bob.getByTestId('terrain-row').filter({ hasText: '10.20.1.5' })).toContainText(
      'Domain controller',
    );

    // server-side filtering
    await ann.locator('#tPort').fill('445');
    await expect(ann.getByTestId('terrain-row')).toHaveCount(2);
    await ann.locator('#tPort').fill('');
    await expect(ann.getByTestId('terrain-row')).toHaveCount(6);

    // promoting on one side creates the case host everywhere, linked by address
    await ann
      .getByTestId('terrain-row')
      .filter({ hasText: '10.20.1.5' })
      .getByTestId('promote-host')
      .click();
    await expect(bob.getByTestId('st-hosts')).toHaveText('1');
    await expect(bob.getByTestId('terrain-row').filter({ hasText: '10.20.1.5' })).toContainText(
      'dc-corp-01',
    );

    // bob marks it compromised; ann's map overlays the new status on the terrain
    await bob.getByTestId('tab-hosts').click();
    await bob.getByTestId('host-card').click();
    await bob.getByRole('dialog').getByLabel('Status').selectOption('compromised');
    await bob.getByTestId('host-save').click();
    await ann.getByTestId('tab-map').click();
    await expect(ann.getByTestId('map-hub')).toHaveCount(5);
    await ann.getByTestId('expand-all').click();
    await expect(ann.getByTestId('map-host')).toHaveCount(6);
    // the linked host is ringed in the compromised colour
    await expect(ann.locator('[data-testid="map-host"] circle[stroke="#ff1f3d"]')).toHaveCount(1);

    // the alive-host list is available for the next scan phase
    const [download] = await Promise.all([
      ann.waitForEvent('download'),
      ann
        .getByTestId('tab-scans')
        .click()
        .then(() => ann.getByTestId('download-targets').click()),
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'midden-targets-'));
    const saved = join(dir, download.suggestedFilename());
    await download.saveAs(saved);
    expect(readFileSync(saved, 'utf8').trim().split('\n')).toHaveLength(6);

    await ann.context().close();
    await bob.context().close();
  });

  test('attaches evidence to an event, shares it, and serves it safely', async ({ browser }) => {
    const ann = await userPage(browser, 'ann', 'ann-password-123');
    const bob = await userPage(browser, 'bob', 'bob-password-123');
    await ann.locator('#ncName').fill('Evidence Case');
    await ann.getByRole('button', { name: 'Create' }).click();
    await expect(ann).toHaveURL(/#\/c\//);
    const url = ann.url();
    await bob.goto(url);

    // an event to hang the evidence on
    await ann.keyboard.press('n');
    const dlg = ann.getByRole('dialog');
    await dlg.getByLabel('Timestamp', { exact: true }).fill('2026-07-14 13:26:30');
    await dlg.getByLabel('Activity', { exact: true }).fill('LSASS memory dumped');
    await ann.getByTestId('event-save').click();
    await expect(ann.getByRole('dialog')).toBeHidden();
    await expect(bob.getByTestId('st-events')).toHaveText('1');

    // attach a PNG through the editor
    await ann.getByTestId('tab-timeline').click();
    // the row's own Edit button, rather than a double click that can land on it twice
    await ann.getByTestId('timeline-row').first().getByRole('button', { name: 'Edit' }).click();
    await expect(ann.getByRole('dialog')).toBeVisible();
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
        '05fe02fea7a3a0e40000000049454e44ae426082',
      'hex',
    );
    await ann
      .getByTestId('attach-input')
      .setInputFiles({ name: 'lsass.png', mimeType: 'image/png', buffer: png });
    await expect(ann.getByTestId('attachment')).toHaveCount(1);
    await expect(ann.getByTestId('attachment')).toContainText('lsass.png');

    // bob sees it on the same event without reloading
    await bob.getByTestId('tab-timeline').click();
    await bob.getByTestId('timeline-row').first().getByRole('button', { name: 'Edit' }).click();
    await expect(bob.getByRole('dialog')).toBeVisible();
    await expect(bob.getByTestId('attachment')).toHaveCount(1);

    // a file pretending to be an image is served as a download, not rendered
    await ann.getByTestId('attach-input').setInputFiles({
      name: 'notes.png',
      mimeType: 'image/png',
      buffer: Buffer.from('2026-07-14 13:02:41 4624 CORP\\j.reyes logon type 10\n'),
    });
    await expect(ann.getByTestId('attachment')).toHaveCount(2);
    const href = await ann.getByTestId('attachment').nth(1).locator('a').getAttribute('href');
    const served = await ann.request.get(`${BASE}${href}`);
    expect(served.headers()['content-type']).toContain('text/plain');
    expect(served.headers()['content-disposition']).toContain('attachment;');
    expect(served.headers()['x-content-type-options']).toBe('nosniff');

    // an executable is flagged on sight, shown with a warning to both analysts, and every
    // download of it is an encrypted zip rather than the sample itself
    await ann.getByTestId('attach-input').setInputFiles({
      name: 'dropper.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(200, 0xcc)]),
    });
    await expect(ann.getByTestId('attachment')).toHaveCount(3);
    const exe = ann.getByTestId('attachment').nth(2);
    await expect(exe).toHaveAttribute('data-dangerous', '1');
    await expect(exe).toContainText('dangerous');
    await expect(bob.getByTestId('attachment').nth(2)).toHaveAttribute('data-dangerous', '1');
    const exeHref = await exe.locator('a').getAttribute('href');
    const wrapped = await bob.request.get(`${BASE}${exeHref}`);
    expect(wrapped.headers()['content-type']).toContain('application/zip');
    expect(wrapped.headers()['content-disposition']).toContain('dropper.exe.zip');
    expect((await wrapped.body()).indexOf(Buffer.from('MZ\x90', 'latin1'))).toBe(-1);
    await exe.getByTestId('attachment-remove').click();
    await ann.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(ann.getByTestId('attachment')).toHaveCount(2);

    // removing it takes the file with it
    await ann.getByTestId('attachment').nth(1).getByTestId('attachment-remove').click();
    await ann.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(ann.getByTestId('attachment')).toHaveCount(1);
    expect((await ann.request.get(`${BASE}${href}`)).status()).toBe(404);

    await ann.context().close();
    await bob.context().close();
  });

  test('going offline blocks edits and reconnecting catches up on missed changes', async ({
    browser,
  }) => {
    const ann = await userPage(browser, 'ann', 'ann-password-123');
    const bob = await userPage(browser, 'bob', 'bob-password-123');
    await ann.locator('#ncName').fill('Reconnect Case');
    await ann.getByRole('button', { name: 'Create' }).click();
    await expect(ann).toHaveURL(/#\/c\//);
    const url = ann.url();
    await bob.goto(url);
    await expect(bob.locator('#caseName')).toHaveValue('Reconnect Case');

    await bob.context().setOffline(true);
    await expect(bob.getByTestId('banner-offline')).toBeVisible({ timeout: 20_000 });
    // ann keeps working
    await ann.keyboard.press('h');
    await ann.getByRole('dialog').getByLabel('Hostname', { exact: true }).fill('WHILE-OFFLINE');
    await ann.getByTestId('host-save').click();
    await expect(ann.getByTestId('st-hosts')).toHaveText('1');
    // bob cannot edit
    await bob.keyboard.press('h');
    await bob.getByRole('dialog').getByLabel('Hostname', { exact: true }).fill('BLOCKED');
    await bob.getByTestId('host-save').click();
    await expect(bob.getByTestId('toast').filter({ hasText: 'Offline' })).toBeVisible();
    await bob.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await bob.context().setOffline(false);
    await expect(bob.getByTestId('banner-offline')).toBeHidden({ timeout: 15000 });
    await expect(bob.getByTestId('st-hosts')).toHaveText('1');
    await bob.getByTestId('tab-hosts').click();
    await expect(bob.getByTestId('host-card')).toContainText('WHILE-OFFLINE');

    await ann.context().close();
    await bob.context().close();
  });
});
