import { expect, test } from '@playwright/test';
import { openParameters } from './model-helpers';

const api = process.env.SCENARIO_TEST_API;
test.skip(!api || !/^water_test_[a-f0-9]{32}$/.test(process.env.SCENARIO_TEST_DB ?? ''), 'Requires the isolated API.');
const media = process.env.REGIONAL_WATER_MEDIA === '1';

for (const width of [1280, 375]) test(`whole-area water atlas, district detail and Don demo at ${width}px`, async ({ page }, info) => {
  test.setTimeout(50_000);
  await page.setViewportSize({ width, height: width === 1280 ? 800 : 667 });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: api + url.pathname + url.search }) });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#model');
  await page.getByRole('button', { name: 'Обзор области', exact: true }).click();
  const map = page.getByTestId('regional-map');
  await expect(map.locator('[data-regional-feature="lipetsk-oblast"]')).toBeVisible();
  await expect(map.locator('canvas')).toHaveCount(1);
  await expect(map.locator('[data-regional-reach]')).toHaveCount(3);
  if (media) await page.screenshot({ path: info.outputPath(`whole-area-${width}.png`) });

  const search = page.getByTestId('regional-search');
  const type = page.getByLabel('Тип водного объекта', { exact: true });
  await type.selectOption('lake');
  await search.fill('ОЗЕРО ЧИСТОЕ');
  const homonyms = page.getByRole('button', { name: /озеро Чистое · Озеро · Расчёт не подключён/u });
  await expect(homonyms).toHaveCount(2);
  await expect(homonyms.first()).toHaveAccessibleName(/° с\. ш\./u);
  await homonyms.first().click();
  const first = await map.getAttribute('data-selected-feature');
  await homonyms.nth(1).click();
  await expect(map).not.toHaveAttribute('data-selected-feature', first!);
  await expect(page.getByTestId('regional-object-card')).toContainText('Для объекта не подключён');
  await expect(page.getByRole('button', { name: 'К выбранному участку', exact: true })).toHaveCount(0);

  await search.fill('Богородицкое');
  await page.getByRole('button', { name: /^озеро Богородицкое · Озеро/u }).click();
  await expect(map).toHaveAttribute('data-selected-feature', 'lake-osm-way-35164445');
  await type.selectOption('');
  await map.getByRole('button', { name: 'Уменьшить масштаб', exact: true }).click();
  if (media) await map.screenshot({ path: info.outputPath(`district-lake-${width}.png`) });
  await page.getByRole('button', { name: 'Вся область', exact: true }).click();
  await type.selectOption('river');
  await search.fill('Дон');
  await page.getByRole('button', { name: /^Дон · Река · Есть подготовленный участок/u }).click();
  const card = page.getByTestId('regional-object-card');
  await expect(card).toContainText('Установлено для выбранного расчётного участка');
  await expect(card).toContainText('Ольховца');
  await card.getByRole('button', { name: 'Учебный расчёт на Дону', exact: true }).click();
  await expect(page.getByText('Учебный паспорт · хлориды', { exact: true })).toBeVisible();
  await openParameters(page);
  const completed = page.waitForResponse(response => response.url().endsWith('/simulations') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  const response = await completed;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.reach_id).toBe('don-olkhovets');
  expect(result.inputs.sources).toHaveLength(1);
  expect(result.inputs.sources[0]).toMatchObject({ load_mode: 'continuous', id: 'discharge-demo-don' });
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  if (media) await page.screenshot({ path: info.outputPath(`don-from-map-${width}.png`) });
});
