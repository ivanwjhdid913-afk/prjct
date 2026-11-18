import { expect, test } from '@playwright/test';
import { sampleSeries, timeBracket, type NetworkResult } from '../src/riverNetworkData';

const api = process.env.SCENARIO_TEST_API;
test.skip(!api || !/^water_test_[0-9a-f]{32}$/.test(process.env.SCENARIO_TEST_DB ?? ''), 'Requires a disposable API/database.');
test.use({ video: 'on' });

for (const width of [1280, 375]) {
  test(`real network pulse, physical time and saved conditions at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: api + url.pathname + url.search }) });
    });
    await page.goto('/#model');
    await page.getByRole('button', { name: 'Обзор области', exact: true }).click();
    await page.getByRole('button', { name: 'Сеть Воронеж — Кузьминка', exact: true }).click();
    await expect(page.getByTestId('river-network-map')).toBeVisible();
    const calculate = async (): Promise<NetworkResult> => {
      const response = page.waitForResponse(r => r.url().endsWith('/river-networks/simulations') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Рассчитать сеть', exact: true }).click();
      const completed = await response;
      expect(completed.status(), await completed.text()).toBe(200);
      const result = await completed.json() as NetworkResult;
      await expect(page.getByRole('button', { name: 'Воспроизвести сеть', exact: true })).toBeEnabled();
      return result;
    };
    const result = await calculate();
    expect(result.reaches).toHaveLength(4);
    expect(result.balance_kg.input.at(-1)).toBeCloseTo(13.5, 9);
    expect(Math.max(...result.balance_kg.residual.map(Math.abs))).toBeLessThan(1e-8);
    const reach = result.reaches.find(item => item.id === 'voronezh-lower')!;
    const cell = reach.distances_m.findIndex(distance => distance >= 80);
    await page.getByLabel('Сегмент речной сети', { exact: true }).selectOption(`${reach.id}:${cell}`);
    const slider = page.getByTestId('river-network-time');
    const seek = async (hour: number) => {
      await slider.fill(String(hour));
      const expected = sampleSeries(reach.concentrations_mg_l.map(row => row[cell]), timeBracket(result.times_hours, hour));
      await expect(page.getByTestId('river-network-chart').locator('output')).toHaveText(`${expected.toLocaleString('ru-RU', { maximumFractionDigits: 3, useGrouping: false })} мг/л`);
    };
    for (const hour of [.05, .15, .5, 1.5]) await seek(hour);
    await seek(.5);
    await page.getByTestId('river-network-map').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`network-${width}.png`), fullPage: true });
    await seek(0);
    await page.getByLabel('Скорость воспроизведения сети', { exact: true }).selectOption('4');
    await page.getByRole('button', { name: 'Воспроизвести сеть', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Воспроизвести сеть', exact: true })).toBeVisible({ timeout: 30000 });
    await expect(slider).toHaveValue('1.5');
    const library = page.locator('.network-saved');
    await library.locator('summary').click();
    const name = `Сетевой контроль ${width} ${Date.now()}`;
    await page.getByLabel('Название условий сети', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Сохранить условия сети', exact: true }).click();
    await expect(library).toContainText('Условия сохранены');
    const option = library.locator('option').filter({ hasText: name });
    const id = await option.getAttribute('value');
    expect(id).toBeTruthy();
    await page.getByLabel('Концентрация сброса', { exact: true }).fill('50');
    await expect(page.getByTestId('river-network-stale')).toBeVisible();
    await page.getByLabel('Сохранённый сценарий сети', { exact: true }).selectOption(id!);
    await page.getByRole('button', { name: 'Открыть условия сети', exact: true }).click();
    await expect(page.getByLabel('Концентрация сброса', { exact: true })).toHaveValue('100');
    const repeated = await calculate();
    expect(repeated).toEqual(result);
    await page.getByRole('button', { name: 'К обзору области', exact: true }).click();
    await expect(page.getByTestId('regional-overview')).toBeVisible();
    expect(errors).toEqual([]);
    await info.attach('network-result', { body: JSON.stringify({ inputs: result.inputs, balance: result.balance_kg, diagnostics: result.diagnostics }), contentType: 'application/json' });
  });
}
