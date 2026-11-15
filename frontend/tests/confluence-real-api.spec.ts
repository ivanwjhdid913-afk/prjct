import { expect, test, type Download, type Page } from '@playwright/test';
import type { Result } from '../src/confluenceData';

const api = process.env.SCENARIO_TEST_API;
const validTestDb = /^water_test_[0-9a-f]{32}$/.test(process.env.SCENARIO_TEST_DB ?? '');
test.skip(!api || !validTestDb, 'Requires the isolated scenario API.');
test.use({ video: process.env.CONFLUENCE_MEDIA === '1' ? 'on' : 'off' });

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function downloadText(download: Download) {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 667 }]) {
  test(`actual confluence pilot with playback, node, C(t) and exports at ${viewport.width}px`, async ({ page }, info) => {
    test.setTimeout(45_000);
    await page.setViewportSize(viewport);
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: api + url.pathname + url.search });
      await route.fulfill({ response });
    });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/#model');
    await expect(page.locator('#multiple-reach')).toHaveValue('don-olkhovets');
    const oldSource = page.locator('#multiple-source-distance');
    if (viewport.width === 375) await button(page, 'Параметры').click();
    await oldSource.fill('100');
    if (viewport.width === 375) await button(page, 'Закрыть параметры').click();
    await page.getByRole('link', { name: 'Слияние рек', exact: true }).click();
    const map = page.getByTestId('confluence-map');
    await expect(map).toBeVisible();
    await expect(map.locator('[data-confluence-branch]')).toHaveCount(3);
    await expect.poll(() => map.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll('[data-confluence-branch], .confluence-map-node-button')].every(feature => {
        const shape = feature.getBoundingClientRect();
        return shape.width > 0 && shape.height > 0 && shape.left >= bounds.left && shape.right <= bounds.right &&
          shape.top >= bounds.top && shape.bottom <= bounds.bottom && shape.top >= 0 && shape.bottom <= innerHeight;
      });
    })).toBe(true);

    const completed = page.waitForResponse(response => response.url().endsWith('/api/v1/confluence/simulations'));
    await button(page, 'Рассчитать слияние').click();
    const response = await completed;
    expect(response.status()).toBe(200);
    const result: Result = await response.json();
    expect(result.flows_m3_s).toEqual({ a: 8, b: 2, out: 10 });
    expect(result.balance_kg.input.at(-1)).toBeCloseTo(72, 10);
    expect(result.balance_kg.output.at(-1)).toBeCloseTo(72, 5);
    expect(Math.max(...result.balance_kg.residual.map(Math.abs))).toBeLessThan(1e-9);
    const duration = result.times_hours.at(-1)!;
    const clock = page.getByTestId('confluence-time');
    await expect(clock).toBeEnabled();
    const legend = await page.getByTestId('confluence-legend').innerText();
    await button(page, 'Воспроизвести расчёт').click();
    await expect.poll(async () => result.times_hours[Number(await clock.inputValue())], { timeout: 7500 }).toBeGreaterThan(0.85);
    await button(page, 'Приостановить расчёт').click();
    const paused = await clock.inputValue();
    await expect(clock).toHaveValue(paused);
    expect(result.times_hours[Number(paused)]).toBeLessThan(duration);
    const nodePeak = result.junction_mg_l.out.indexOf(Math.max(...result.junction_mg_l.out));
    await clock.fill(String(nodePeak));
    const nodeMarker = map.getByRole('button', { name: 'Узел слияния', exact: true });
    await nodeMarker.click();
    const node = page.getByTestId('confluence-node');
    await expect(node).toContainText('10 м³/с');
    await expect(node).toContainText(result.junction_mg_l.out[nodePeak].toLocaleString('ru-RU', { maximumFractionDigits: 3 }));
    expect(result.junction_mg_l.out[nodePeak]).toBeLessThan(result.junction_mg_l.a[nodePeak]);
    await expect(page.getByTestId('confluence-legend')).toHaveText(legend, { useInnerText: true });
    await expect(map).toBeInViewport();
    if (process.env.CONFLUENCE_MEDIA === '1')
      await page.screenshot({ path: info.outputPath(`node-${viewport.width}.png`) });

    await button(page, 'Ниже узла').click();
    await page.getByLabel('Расчётный сегмент ниже узла').selectOption('20');
    const chart = page.getByTestId('confluence-chart');
    await expect(chart.getByRole('img')).toBeVisible();
    const downPeak = result.concentrations_mg_l.out.reduce((best, row, i, rows) => row[20] > rows[best][20] ? i : best, 0);
    await clock.fill(String(downPeak));
    await expect(chart).toContainText(result.concentrations_mg_l.out[downPeak][20].toLocaleString('ru-RU', { maximumFractionDigits: 3 }));
    if (process.env.CONFLUENCE_MEDIA === '1')
      await page.screenshot({ path: info.outputPath(`profile-${viewport.width}.png`), fullPage: true });

    const [jsonDownload] = await Promise.all([page.waitForEvent('download'), button(page, 'Скачать JSON').click()]);
    const json = JSON.parse(await downloadText(jsonDownload));
    expect(json.model_id).toBe('conservative-1d-confluence-v1');
    expect(json.geometry.id).toBe('synthetic-confluence-v1');
    expect(json.inputs).toEqual(result.inputs);
    expect(json).not.toHaveProperty('concentrations_mg_l');
    const [csvDownload] = await Promise.all([page.waitForEvent('download'), button(page, 'Скачать CSV').click()]);
    const [header, ...rows] = (await downloadText(csvDownload)).trim().split(/\r?\n/).map(row => row.split(','));
    const segmentRows = rows.filter(row => row[0] === 'segment');
    expect(segmentRows.length).toBe(result.times_hours.length * Object.values(result.grid.cells).reduce((sum, count) => sum + count, 0));
    expect(new Set(segmentRows.map(row => row[header.indexOf('branch_id')]))).toEqual(new Set(['a', 'b', 'out']));
    expect(rows.filter(row => row[0] === 'balance')).toHaveLength(result.times_hours.length * 4);
    expect(Number(rows.at(-1)![header.indexOf('time_hours')])).toBe(duration);
    expect(rows.at(-1)![header.indexOf('branch_id')]).toBe('network');
    expect(Number(rows.at(-1)![header.indexOf('input_delta_from_background_kg')])).toBeCloseTo(72, 10);
    expect(Number(rows.at(-2)![header.indexOf('output_delta_from_background_kg')])).toBeCloseTo(72, 5);
    expect(pageErrors).toEqual([]);
    await page.getByRole('link', { name: /К прежней модели/ }).click();
    await expect(oldSource).toHaveValue('100');
  });
}

test('the actual pilot exports a zero-concentration pulse as a signed deficit', async ({ page }) => {
  await page.route('**/api/v1/confluence/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: api + url.pathname }) });
  });
  await page.goto('/#model/confluence');
  await page.getByRole('spinbutton', { name: 'Концентрация на входе A', exact: true }).fill('0');
  const completed = page.waitForResponse(response => response.url().endsWith('/api/v1/confluence/simulations'));
  await button(page, 'Рассчитать слияние').click();
  const response = await completed;
  expect(response.status()).toBe(200);
  const result: Result = await response.json();
  expect(result.inputs.background_mg_l).toBe(10);
  expect(result.inputs.branches.find(branch => branch.id === 'a')).toMatchObject({
    flow_m3_s: 8, load_duration_minutes: 15, concentration_mg_l: 0,
  });
  expect(result.balance_kg.input.at(-1)).toBeCloseTo(-72, 10);

  const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Скачать CSV').click()]);
  const [header, ...rows] = (await downloadText(download)).trimEnd().split(/\r?\n/).map(row => row.split(','));
  const metadata = rows.find(row => row[0] === 'metadata')!;
  expect(metadata[header.indexOf('csv_schema_version')]).toBe('2');
  expect(metadata[header.indexOf('background_mg_l')]).toBe('10');
  expect(metadata[header.indexOf('balance_reference')]).toBe('relative_to_background');
  const end = rows.at(-1)!;
  expect(end[header.indexOf('branch_id')]).toBe('network');
  expect(Number(end[header.indexOf('input_delta_from_background_kg')])).toBeCloseTo(-72, 10);
  expect(Number(end[header.indexOf('output_delta_from_background_kg')])).toBeCloseTo(-72, 5);
});
