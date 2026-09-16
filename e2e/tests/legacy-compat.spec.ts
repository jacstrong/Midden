import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEGACY = resolve(import.meta.dirname, '../../legacy/midden_attack_timeline.html');
const STANDALONE = resolve(import.meta.dirname, '../../packages/web/dist-standalone/index.html');

/**
 * Compatibility in both directions with the original prototype: a file the prototype saved
 * opens in the new build, and a file the new build saved opens in the prototype.
 */
test.describe('legacy prototype compatibility', () => {
  test.skip(
    !existsSync(LEGACY) || !existsSync(STANDALONE),
    'needs legacy/ and the standalone build',
  );

  test('a case exported by the prototype opens in the new standalone', async ({ page }) => {
    await page.goto(pathToFileURL(LEGACY).href);
    await page.getByRole('button', { name: 'Load example case' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'midden-legacy-'));
    const saved = join(dir, download.suggestedFilename());
    await download.saveAs(saved);
    const file = JSON.parse(readFileSync(saved, 'utf8'));
    expect(file.schema).toBe('midden.case.v1');

    await page.goto(pathToFileURL(STANDALONE).href);
    await page.evaluate(() => {
      (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = undefined;
    });
    await page.getByTestId('btn-open').click();
    await page.getByTestId('file-input').setInputFiles(saved);
    await expect(page.getByTestId('st-events')).toHaveText('14');
    await expect(page.getByTestId('st-hosts')).toHaveText('5');
    await expect(page.locator('#caseName')).toHaveValue('Operation Glasshouse');
    await page.getByTestId('tab-report').click();
    await expect(page.getByTestId('report').locator('h1')).toContainText(
      'Operation Glasshouse · IR-2026-0142',
    );
    await expect(page.getByTestId('report')).toContainText(
      'DCSync — directory replication of all domain secrets',
    );
  });

  test('a case exported by the new standalone opens in the prototype', async ({ page }) => {
    await page.goto(pathToFileURL(STANDALONE).href);
    await page.getByTestId('load-demo').click();
    await expect(page.getByTestId('st-events')).toHaveText('14');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'midden-v2-'));
    const saved = join(dir, download.suggestedFilename());
    await download.saveAs(saved);

    await page.goto(pathToFileURL(LEGACY).href);
    await page.locator('#fileInput').setInputFiles(saved);
    await expect(page.locator('#stEvents')).toHaveText('14');
    await expect(page.locator('#stHosts')).toHaveText('5');
    await expect(page.locator('#caseName')).toHaveValue('Operation Glasshouse');
  });
});
