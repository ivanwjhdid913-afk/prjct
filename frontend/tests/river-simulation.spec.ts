import { expect, test } from '@playwright/test';

const reach = { id: 'test-reach', name: 'Проверочный участок', length_m: 1000, geometry: { type: 'LineString', coordinates: [[39.2, 52.5], [39.201, 52.502], [39.203, 52.501], [39.205, 52.503]] }, distances_m: [0, 300, 600, 1000], metadata: { attribution: 'Тестовый источник геометрии', source_url: 'https://example.org', direction_basis: 'Проверочная направленная линия' } };

test.beforeEach(async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [reach] } }));
});

test('malformed reach data gives a recoverable error instead of a broken map', async ({ page }) => {
  await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [{ ...reach, metadata: null }] } }));
  await page.goto('/#model');
  await page.getByLabel('Геометрия сценария').selectOption('river');
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить подготовленный участок');
  await expect(page.getByRole('button', { name: 'Рассчитать', exact: true })).toBeDisabled();
});

test('rejects malformed synthetic and river result geometries', async ({ page }) => {
  const actual = await (await page.request.post('/api/v1/simulations', { data: { river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10, effluent_mg_l: 100, velocity_m_s: .25, dispersion_m2_s: 5, length_m: 10000, duration_hours: 1 } })).json();
  let attempt = 0;
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: ++attempt === 1 ? { ...actual, geometry: { type: 'LineString', coordinates: [[39, 52], [39.1, 52.1]] } } : { ...actual, reach_id: 'bad', segment_geometries: Array(100).fill(null) } }));
  await page.goto('/#model');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер вернул неполные результаты');
  await page.getByRole('button', { name: 'Повторить расчёт', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер вернул неполные результаты');
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toHaveCount(0);
});

test('selects a river source, sends geometry identity and marks changed source stale', async ({ page }) => {
  let request: Record<string, number | string> = {};
  await page.route('**/api/v1/simulations', async route => {
    request = route.request().postDataJSON();
    await route.fulfill({ json: { inputs: { ...request, length_m: 500 }, derived: { total_flow_m3_s: 10.1, area_m2: 40.4, load_kg_s: .01, excess_load_kg_s: .009, steady_mg_l: 11, travel_hours: 1 }, distances_m: [125, 375], times_hours: [0, 12, 24], concentrations_mg_l: [[10, 10], [12, 10], [14, 12]], scale_mg_l: [10, 14], geometry: reach.geometry, provenance: 'river_scenario', reach_id: reach.id, source_distance_m: 500, source_coordinate: [39.202, 52.5015], reach_metadata: { ...reach.metadata, name: reach.name }, segment_geometries: [reach.geometry, reach.geometry] } });
  });
  await page.goto('/#model');
  await page.getByLabel('Геометрия сценария').selectOption('river');
  await page.getByLabel('Положение сценарного источника, м').fill('500');
  await expect(page.getByLabel('Длина участка L, м')).toHaveValue('500');
  await expect(page.getByLabel('Длина участка L, м')).toHaveAttribute('readonly', '');
  await expect(page.locator('.scenario-source-marker').first()).toBeVisible();
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  expect(request.reach_id).toBe(reach.id);
  expect(request.source_distance_m).toBe(500);
  expect(request).not.toHaveProperty('length_m');
  await expect(page.locator('.simulation-segment')).toHaveCount(2);
  await page.getByLabel('Время от начала сценария').fill('0.5');
  await expect(page.getByTestId('selected-concentration')).toHaveText('11,0000 мг/л');
  await expect(page.locator('.simulation-segment').first()).toHaveAttribute('data-concentration', '11');
  await page.getByLabel('Положение сценарного источника, м').fill('501');
  await expect(page.getByText('Параметры изменены. Результат относится к предыдущим условиям.', { exact: true })).toBeVisible();
});

test('plays, pauses, changes speed and seeks consistently without automatic playback', async ({ page }) => {
  await page.goto('/#model');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  const slider = page.getByLabel('Время от начала сценария');
  await expect(slider).toHaveValue('0');
  await page.getByLabel('Скорость воспроизведения').selectOption('4');
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const paused = await slider.inputValue();
  await page.waitForTimeout(120);
  await expect(slider).toHaveValue(paused);
  await slider.fill('12.5');
  await expect(page.getByRole('button', { name: 'Воспроизвести', exact: true })).toBeVisible();
  await expect(slider).toHaveValue('12.5');
  await slider.fill('48');
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(48);
});

for (const width of [375, 1440]) {
  test(`real river API, interpolated map/profile/table and layout at ${width}px`, async ({ page, request }) => {
    await page.unroute('**/api/v1/river-reaches');
    const reaches = await (await request.get('/api/v1/river-reaches')).json();
    const actual = reaches.items[0];
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/#model');
    await page.getByLabel('Геометрия сценария').selectOption('river');
    await page.getByLabel('Положение сценарного источника, м').fill(String(actual.length_m / 2));
    await page.getByLabel('Длительность, ч').fill('6');
    const response = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    const result = await response;
    expect(result.ok()).toBeTruthy();
    const data = await result.json();
    expect(data.reach_id).toBe(actual.id);
    expect(data.inputs.length_m).toBeCloseTo(actual.length_m / 2, 6);
    await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
    await page.getByLabel('Время от начала сценария').fill('12.5');
    const expected = data.concentrations_mg_l[12].map((value: number, index: number) => value + .5 * (data.concentrations_mg_l[13][index] - value));
    const mapValues = await page.locator('.simulation-segment').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-concentration'))));
    expect(mapValues).toEqual(expected);
    const profile = (await page.locator('.simulation-profile polyline').getAttribute('points'))!;
    profile.split(' ').forEach((point, index) => {
      const concentration = data.scale_mg_l[0] + (190 - Number(point.split(',')[1])) * (data.scale_mg_l[1] - data.scale_mg_l[0]) / 160;
      expect(concentration).toBeCloseTo(expected[index], 12);
    });
    await page.getByText('Таблица профиля', { exact: true }).click();
    const values = await page.getByRole('table', { name: 'Рассчитанный профиль' }).locator('tbody tr td:last-child').allTextContents();
    expect(values).toEqual(expected.map((value: number) => value.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: `test-results/river-${width}.png`, fullPage: true });
  });
}
