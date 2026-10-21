import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
});

test('opens a map-first Don workspace with the timeline in the laptop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/#model');
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
  await expect(page.getByLabel('Подготовленный участок')).toContainText('Дон');
  await expect(page.locator('.scenario-source-marker')).toBeVisible();
  const map = await page.locator('.model-map-stage').boundingBox();
  expect(map!.width).toBeGreaterThan(850);
  expect(map!.height).toBeGreaterThan(400);
  await expect(page.getByLabel('Время от начала сценария')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Запустить демонстрацию' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(768);
});

test('explicit demonstration runs a four-hour preset and preserves the map view during playback', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/#model');
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('321');
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations'));
  await page.getByRole('button', { name: 'Запустить демонстрацию' }).click();
  const actual = await response;
  expect(actual.ok()).toBeTruthy();
  expect(actual.request().postDataJSON()).toMatchObject({ duration_hours: 4, source_distance_m: 0, effluent_mg_l: 100 });
  await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('100');
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Увеличить масштаб', exact: true }).click();
  const mapBounds = (await page.locator('.simulation-map').boundingBox())!;
  await page.mouse.move(mapBounds.x + mapBounds.width / 2, mapBounds.y + mapBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBounds.x + mapBounds.width / 2 + 45, mapBounds.y + mapBounds.height / 2 + 20, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const layer = page.locator('.simulation-map .leaflet-map-pane');
  const transform = await layer.getAttribute('style');
  const firstPath = await page.locator('.simulation-segment').first().getAttribute('d');
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Время от начала сценария').inputValue())).toBeGreaterThan(2 / 12);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  expect(await layer.getAttribute('style')).toBe(transform);
  expect(await page.locator('.simulation-segment').first().getAttribute('d')).toBe(firstPath);
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('222');
  await expect(page.locator('.simulation-stale')).toBeInViewport();
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.locator('.simulation-stale')).toHaveCount(0);
  await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('222');
});

test('mobile panels collapse without losing access to the map and timeline', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#model');
  await expect(page.locator('.scenario-source-marker')).toBeVisible();
  await expect(page.getByLabel('Время от начала сценария')).toBeInViewport();
  const toggle = page.getByRole('button', { name: 'Параметры', exact: true });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Геометрия сценария')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть параметры' }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Запустить демонстрацию' })).toBeInViewport();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('mobile profile moves keyboard focus into the panel and leaves timeline accessible', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#model');
  await expect(page.locator('.scenario-badge')).toBeVisible();
  await page.getByRole('button', { name: 'Запустить демонстрацию' }).click();
  const open = page.getByRole('button', { name: 'Профиль и показатели', exact: true });
  await open.click();
  await expect(page.getByRole('button', { name: 'Закрыть профиль' })).toBeFocused();
  await expect(page.locator('.map-inspector')).toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'Воспроизвести', exact: true })).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(open).toBeFocused();
});

test('short mobile viewport keeps the river legible above its inspector', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/#model');
  await page.getByRole('button', { name: 'Запустить демонстрацию' }).click();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  const bounds = await page.locator('.simulation-segment').evaluateAll(elements => {
    const boxes = elements.map(element => element.getBoundingClientRect());
    return { top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)) };
  });
  const inspector = (await page.locator('.map-inspector').boundingBox())!;
  expect(bounds.bottom - bounds.top).toBeGreaterThan(120);
  expect(bounds.bottom).toBeLessThan(inspector.y);
  await expect(page.getByLabel('Время от начала сценария')).toBeInViewport();
  await expect(page.getByLabel('Расчётный сегмент')).toBeInViewport();
  await page.screenshot({ path: 'test-results/model-short-mobile.png' });
});
