import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STANDALONE = resolve(import.meta.dirname, '../../packages/web/dist-standalone/index.html');
const DISCOVERY_XML = resolve(
  import.meta.dirname,
  '../../packages/core/fixtures/nmap/lab-discovery.xml',
);
const SCAN_XML = resolve(import.meta.dirname, '../../packages/core/fixtures/nmap/lab-small.xml');
const FIXTURE_V1 = resolve(import.meta.dirname, '../../packages/core/fixtures/demo-case-v1.json');

test.describe('standalone single-file build', () => {
  test.skip(!existsSync(STANDALONE), 'run `pnpm build:standalone` first');

  const open = async (page: Page): Promise<string[]> => {
    const external: string[] = [];
    page.on('request', (req) => {
      if (!/^(file|blob|data):/.test(req.url())) external.push(req.url());
    });
    await page.goto(pathToFileURL(STANDALONE).href);
    await expect(page.locator('.brand b')).toHaveText('MIDDEN');
    return external;
  };

  test('boots from file:// in standalone mode with a working data-URL worker and no network', async ({
    page,
  }) => {
    const external = await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'standalone');
    await expect(page.locator('html')).toHaveAttribute('data-worker', 'pong:ping');
    await expect(page.locator('.empty b')).toHaveText('No investigation loaded');
    expect(external).toEqual([]);
  });

  test('loads the example case and renders every view', async ({ page }) => {
    await open(page);
    await page.getByTestId('load-demo').click();
    await expect(page.getByTestId('st-events')).toHaveText('14');
    await expect(page.getByTestId('st-hosts')).toHaveText('5');
    await expect(page.locator('#caseName')).toHaveValue('Operation Glasshouse');
    expect(await page.getByTestId('graph-node').count()).toBe(14);
    await expect(page.locator('path[marker-end]')).toHaveCount(5);

    await page.getByTestId('tab-timeline').click();
    await expect(page).toHaveURL(/#\/timeline$/);
    await expect(page.getByTestId('timeline-row').first()).toContainText(
      'Phishing email delivered',
    );

    await page.getByTestId('tab-hosts').click();
    await expect(page.getByTestId('host-card')).toHaveCount(5);

    await page.getByTestId('tab-pivot').click();
    await expect(page.getByTestId('ioc-row')).toHaveCount(11);

    await page.getByTestId('tab-matrix').click();
    await expect(page.locator('.mcell.hit')).toHaveCount(14);

    await page.getByTestId('tab-report').click();
    await expect(page.getByTestId('report').locator('h1')).toContainText(
      'Operation Glasshouse · IR-2026-0142',
    );
  });

  test('adds, edits, filters and deletes events with the timeline reflecting each change', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('load-demo').click();
    await expect(page.getByTestId('st-events')).toHaveText('14');
    await page.getByTestId('tab-timeline').click();
    await expect(page.getByTestId('timeline-row')).toHaveCount(14);

    // add via keyboard shortcut
    await page.keyboard.press('n');
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Timestamp', { exact: true }).fill('2026-07-14 18:30:00');
    await dlg
      .getByLabel('Activity', { exact: true })
      .fill('Containment: C2 egress blocked at the firewall');
    await dlg.getByLabel('Tactic', { exact: true }).selectOption('TA0040');
    await page.getByTestId('event-save').click();
    await expect(dlg).toBeHidden();
    await expect(page.getByTestId('st-events')).toHaveText('15');
    await expect(page.getByTestId('dirty')).toHaveClass(/on/);

    // the new event is last and selected
    const rows = page.getByTestId('timeline-row');
    await expect(rows.last()).toContainText('Containment: C2 egress blocked');

    // edit it: change one field, verify only that field changed
    await rows.last().dblclick();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByLabel('Account', { exact: true }).fill('CORP\\soc');
    await page.getByTestId('event-save').click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(rows.last()).toContainText('CORP\\soc');
    await expect(rows.last()).toContainText('Containment: C2 egress blocked');

    // filter by search text
    await page.locator('#fSearch').fill('dcsync');
    await expect(rows).toHaveCount(1);
    await page.getByTestId('clear-filters').click();
    await expect(rows).toHaveCount(15);

    // delete through the editor
    await rows.last().dblclick();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('st-events')).toHaveText('14');
  });

  test('saves a case file, reopens it, and merges a v1 prototype export', async ({
    page,
  }, testInfo) => {
    await open(page);
    await page.getByTestId('load-demo').click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'midden-e2e-'));
    const saved = join(dir, download.suggestedFilename());
    await download.saveAs(saved);
    const file = JSON.parse(readFileSync(saved, 'utf8'));
    expect(file.schema).toBe('midden.case.v2');
    expect(file.events).toHaveLength(14);
    await expect(page.getByTestId('dirty')).not.toHaveClass(/on/);
    testInfo.attach('case.json', { path: saved });

    // start over, then reopen the saved file through the fallback <input type=file>
    await page.getByTestId('btn-menu').click();
    await page.getByRole('button', { name: 'Start a new empty case' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear everything' }).click();
    await expect(page.getByTestId('st-events')).toHaveText('0');

    await page.evaluate(() => {
      // force the <input type=file> path so setInputFiles can drive it in every engine
      (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = undefined;
    });
    await page.getByTestId('btn-open').click();
    await page.getByTestId('file-input').setInputFiles(saved);
    await expect(page.getByTestId('st-events')).toHaveText('14');
    await expect(page.locator('#caseName')).toHaveValue('Operation Glasshouse');

    // merging the prototype's v1 export adds only the unknown ids
    const v1 = join(dir, 'v1.json');
    writeFileSync(v1, readFileSync(FIXTURE_V1));
    await page.getByTestId('btn-open').click();
    await page.getByTestId('file-input').setInputFiles(v1);
    await page.getByTestId('import-merge').click();
    // fixture: 4 readable events, all with ids unknown to the demo; hosts h_wks/h_file/h_dc already exist
    await expect(page.getByTestId('st-events')).toHaveText('18');
    await expect(page.getByTestId('st-hosts')).toHaveText('8');
  });

  test('parses an nmap scan in a worker, maps the terrain, and promotes a host into the case', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('load-demo').click();
    await page.getByTestId('tab-scans').click();
    await page.getByTestId('scan-file-input').setInputFiles(SCAN_XML);

    // parsed entirely in the page: 6 live hosts from the lab fixture
    await expect(page.getByTestId('terrain-row')).toHaveCount(6);
    await expect(page.getByTestId('scan-tab')).toHaveCount(1);
    const dcRow = page.getByTestId('terrain-row').filter({ hasText: '10.20.1.5' });
    await expect(dcRow).toContainText('Domain controller');
    await expect(dcRow).toContainText('Windows');

    // filters run against the parsed hosts
    await page.locator('#tPort').fill('445');
    await expect(page.getByTestId('terrain-row')).toHaveCount(2);
    await page.locator('#tPort').fill('');
    await page.locator('#tQ').fill('nginx');
    await expect(page.getByTestId('terrain-row')).toHaveCount(1);
    await page.locator('#tQ').fill('');
    await expect(page.getByTestId('terrain-row')).toHaveCount(6);

    // the demo case already owns 10.20.1.5, so the scan auto-links it rather than offering to add it
    await expect(dcRow).toContainText('DC-CORP-01');
    await expect(dcRow.getByTestId('promote-host')).toHaveCount(0);

    // a host that is not in the case yet can be promoted, and then shows as linked
    const printerRow = page.getByTestId('terrain-row').filter({ hasText: '10.20.9.100' });
    await printerRow.getByTestId('promote-host').click();
    await expect(page.getByTestId('st-hosts')).toHaveText('6');
    await expect(printerRow).toContainText('10.20.9.100');
    await expect(printerRow.getByTestId('promote-host')).toHaveCount(0);

    // the map draws one hub per subnet and expands to individual hosts
    await page.getByTestId('tab-map').click();
    await expect(page.getByTestId('map-hub')).toHaveCount(5);
    await page.getByTestId('expand-all').click();
    await expect(page.getByTestId('map-host')).toHaveCount(6);
    await page.getByTestId('map-host').first().click();
    await expect(page.getByTestId('map-inspector')).toBeVisible();

    // the scan travels in the saved case file
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'midden-terrain-'));
    const saved = join(dir, download.suggestedFilename());
    await download.saveAs(saved);
    const file = JSON.parse(readFileSync(saved, 'utf8'));
    expect(file.scans).toHaveLength(1);
    expect(file.scans[0].hosts).toHaveLength(6);

    await page.evaluate(() => {
      (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = undefined;
    });
    await page.getByTestId('btn-open').click();
    await page.getByTestId('file-input').setInputFiles(saved);
    // the case is not empty, so Midden asks whether to merge or replace
    await page.getByTestId('import-replace').click();
    await page.getByTestId('tab-scans').click();
    await expect(page.getByTestId('terrain-row')).toHaveCount(6);
    await expect(page.getByTestId('st-hosts')).toHaveText('6');
  });

  test('builds the two-phase nmap workflow and hands off the alive-host list', async ({ page }) => {
    await open(page);
    await page.getByTestId('tab-builder').click();

    // phase 1: find live hosts on the target subnets
    await page.getByTestId('builder-targets').fill('10.20.0.0/16\n192.168.1.1-50');
    const command = page.getByTestId('builder-command');
    await expect(command).toContainText('sudo nmap -sn -T4 -n');
    await expect(command).toContainText('10.20.0.0/16 192.168.1.1-50');
    await expect(command).toContainText('-oX discovery.xml');
    await expect(page.getByTestId('builder-error')).toHaveCount(0);

    // bad targets are called out rather than silently dropped
    await page.getByTestId('builder-targets').fill('10.20.0.0/16 not_a_target!');
    await expect(page.locator('.err').filter({ hasText: 'not valid nmap targets' })).toBeVisible();
    await page.getByTestId('builder-targets').fill('10.20.0.0/16');

    // phase 2 needs a discovery scan before it can name the alive hosts
    await page.getByTestId('phase-service-scan').click();
    await expect(page.getByTestId('builder-no-discovery')).toBeVisible();
    await expect(command).toContainText('-iL alive.txt');
    await expect(command).toContainText('-sS -sV -O -sC --traceroute');

    // upload the phase-1 results, then phase 2 can hand over the target list
    await page.getByTestId('tab-scans').click();
    await page.getByTestId('scan-file-input').setInputFiles(DISCOVERY_XML);
    await expect(page.getByTestId('terrain-row')).toHaveCount(5);
    await page.getByTestId('tab-builder').click();
    await page.getByTestId('phase-service-scan').click();
    await expect(page.getByTestId('builder-source-scan')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('builder-download-targets').click(),
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'midden-builder-'));
    const saved = join(dir, download.suggestedFilename());
    await download.saveAs(saved);
    expect(readFileSync(saved, 'utf8').trim().split('\n')).toEqual([
      '10.20.0.1',
      '10.20.1.5',
      '10.20.4.31',
      '10.20.4.77',
      '10.20.9.100',
    ]);

    // unprivileged users are told a SYN scan will not work
    await page.locator('#bPriv').selectOption('user');
    await expect(page.getByTestId('builder-error')).toContainText('need root');
  });

  test('keeps work in the browser across a reload and a closed tab', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('status-light')).toHaveAttribute('data-tone', 'local');
    await page.getByTestId('load-demo').click();
    await page.keyboard.press('h');
    await page.getByRole('dialog').getByLabel('Hostname', { exact: true }).fill('SURVIVOR-01');
    await page.getByTestId('host-save').click();
    await expect(page.getByTestId('st-hosts')).toHaveText('6');
    // the light says where the work is
    await page.getByTestId('status-light').hover();
    await expect(page.getByRole('tooltip')).toContainText(/kept in this browser/i);

    await page.reload();
    await expect(page.locator('.brand b')).toHaveText('MIDDEN');
    await expect(page.getByText(/Restored your work/)).toBeVisible();
    await expect(page.getByTestId('st-hosts')).toHaveText('6');
    await page.getByTestId('tab-hosts').click();
    await expect(page.locator('.hcard', { hasText: 'SURVIVOR-01' })).toBeVisible();
    // it was never saved to a file, and the app still knows that
    await expect(page.getByTestId('dirty')).toHaveClass(/on/);

    // a closed tab is the same story: a new page in the same browser profile gets it back
    const again = await page.context().newPage();
    await page.close();
    await again.goto(pathToFileURL(STANDALONE).href);
    await expect(again.getByTestId('st-hosts')).toHaveText('6');
  });

  test('warns before leaving only when the work would actually be lost', async ({ browser }) => {
    const prevented = (p: Page): Promise<boolean> =>
      p.evaluate(() => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
    const edit = async (p: Page): Promise<void> => {
      await p.getByTestId('load-demo').click();
      await p.keyboard.press('h');
      await p.getByRole('dialog').getByLabel('Hostname', { exact: true }).fill('NEW-HOST');
      await p.getByTestId('host-save').click();
      await expect(p.getByTestId('dirty')).toHaveClass(/on/);
    };

    // autosave working: the work is safe in the browser, so leaving is not interrupted
    const page = await (await browser.newContext()).newPage();
    await open(page);
    await edit(page);
    await page.getByTestId('status-light').hover();
    await expect(page.getByRole('tooltip')).toContainText(/kept in this browser/i);
    expect(await prevented(page)).toBe(false);
    await page.context().close();

    // storage blocked (a locked-down or private browser): the warning is all that stands
    // between the analyst and losing the work, so it stays
    const locked = await (await browser.newContext()).newPage();
    await locked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    await open(locked);
    await edit(locked);
    await locked.getByTestId('status-light').hover();
    await expect(locked.getByRole('tooltip')).toContainText(/will not keep your work/i);
    expect(await prevented(locked)).toBe(true);
    await locked.context().close();
  });

  test('keeps the timeline virtualized with thousands of events', async ({ page }) => {
    await open(page);
    // build a 5,000-event case in the page and load it through the normal import path
    const dir = mkdtempSync(join(tmpdir(), 'midden-big-'));
    const big = join(dir, 'big.json');
    const events = Array.from({ length: 5000 }, (_, i) => ({
      id: `ev_${i}`,
      ts: new Date(Date.UTC(2026, 6, 14, 0, 0, i)).toISOString(),
      off: 0,
      hostId: i % 2 ? 'h_a' : 'h_b',
      srcHostId: '',
      user: `user${i % 7}`,
      activity: `Event number ${i}`,
      tactic: 'TA0007',
      conf: 'medium',
      sev: 'low',
      key: false,
      tags: [],
    }));
    writeFileSync(
      big,
      JSON.stringify({
        schema: 'midden.case.v2',
        case: { name: 'Big case' },
        hosts: [
          { id: 'h_a', name: 'ALPHA', status: 'suspect' },
          { id: 'h_b', name: 'BRAVO', status: 'clean' },
        ],
        events,
      }),
    );
    await page.evaluate(() => {
      (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = undefined;
    });
    await page.getByTestId('btn-open').click();
    await page.getByTestId('file-input').setInputFiles(big);
    await expect(page.getByTestId('st-events')).toHaveText('5000');
    await page.getByTestId('tab-timeline').click();
    const rows = page.getByTestId('timeline-row');
    await expect(rows.first()).toContainText('Event number 0');
    // only a window of rows is mounted
    expect(await rows.count()).toBeLessThan(120);
    await page.locator('#viewport').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(rows.last()).toContainText('Event number 4999');
    expect(await rows.count()).toBeLessThan(120);
    await page.locator('#fSearch').fill('number 4242');
    await expect(rows).toHaveCount(1);
  });
});
