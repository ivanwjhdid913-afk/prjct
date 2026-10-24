import { expect, test, type Page } from '@playwright/test';
import { openParameters } from './model-helpers';

const don = { id: 'don-olkhovets', name: 'Дон · Ольховец', length_m: 1000, geometry: { type: 'LineString', coordinates: [[39.2, 52.5], [39.201, 52.502], [39.203, 52.501], [39.205, 52.503]] }, distances_m: [0, 300, 600, 1000], metadata: { direction_basis: 'Тестовое направление' } };
const other = { ...don, id: 'another/river', name: 'Другой подготовленный участок', geometry: { type: 'LineString', coordinates: [[39.3, 52.6], [39.301, 52.602], [39.303, 52.601], [39.305, 52.603]] } };
const snap = { reach_id: don.id, source_distance_m: 432.125, coordinate: [39.2017, 52.5017], distance_to_river_m: 12, max_distance_m: 75 };
const result = (payload: Record<string, any>) => ({ inputs: { ...payload, length_m: 1000 - payload.source_distance_m }, derived: { total_flow_m3_s: 10.1, area_m2: 40.4, load_kg_s: .01, excess_load_kg_s: .009, steady_mg_l: 11, travel_hours: 1 }, distances_m: [125, 375], times_hours: [0, payload.duration_hours / 2, payload.duration_hours], concentrations_mg_l: [[10, 10], [12, 10], [14, 12]], scale_mg_l: [10, 14], geometry: don.geometry, reach_id: payload.reach_id, source_distance_m: payload.source_distance_m, source_coordinate: [39.2, 52.5], reach_metadata: { name: don.name }, segment_geometries: [don.geometry, don.geometry] });
async function clickMap(page: Page) { await page.locator('.reach-preview .leaflet-container, .simulation-map').click({ position: { x: 180, y: 150 } }); }
async function arm(page: Page) { await openParameters(page); await page.getByRole('button', { name: 'Указать источник на карте', exact: true }).click(); }
const lineShape = (path: string) => {
  const pairs = [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
  const width = Math.max(...pairs.map(point => point[0])) - Math.min(...pairs.map(point => point[0]));
  return pairs.flatMap(point => [(point[0] - pairs[0][0]) / width, (point[1] - pairs[0][1]) / width]);
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [other, don] } }));
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: result(route.request().postDataJSON()) }));
});

test('default and both demonstrations identify Don even with a reordered catalog', async ({ page }) => {
  await page.goto('/#model');
  await expect(page.getByLabel('Подготовленный участок')).toHaveValue(don.id);
  for (const label of ['Запустить демонстрацию', 'Демонстрация периода']) {
    await openParameters(page);
    await page.getByLabel('Подготовленный участок').selectOption(other.id);
    const sent = page.waitForRequest(request => request.url().endsWith('/simulations'));
    await page.getByRole('button', { name: label, exact: true }).click();
    expect((await sent).postDataJSON()).toMatchObject({ reach_id: don.id, source_distance_m: 0 });
    await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  }
});

test('a missing demo reach is explained without substituting another river', async ({ page }) => {
  await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [other] } }));
  await page.goto('/#model');
  await expect(page.getByText(/Участок Дона.*недоступен/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запустить демонстрацию' })).toBeDisabled();
  await expect(page.getByLabel('Подготовленный участок')).toHaveValue(other.id);
  await expect(page.getByRole('button', { name: 'Рассчитать', exact: true })).toBeEnabled();
  await expect(page.locator('.map-topline')).toContainText(other.name);
});

test('source toggle cancels the active mode, and newer clicks win out of order', async ({ page }) => {
  const releases: (() => void)[] = [];
  await page.route('**/source-snap?*', async route => {
    const index = releases.length;
    await new Promise<void>(resolve => { releases.push(resolve); });
    await route.fulfill({ json: { ...snap, source_distance_m: index ? 500 : 100 } }).catch(() => {});
  });
  await page.goto('/#model');
  await arm(page);
  await page.getByRole('button', { name: 'Указать источник на карте', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Отменить выбор источника' })).toHaveCount(0);
  await arm(page); await clickMap(page);
  await expect.poll(() => releases.length).toBe(1);
  await clickMap(page); await expect.poll(() => releases.length).toBe(2);
  releases[1]();
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('500');
  releases[0](); await page.waitForTimeout(100);
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('500');
});

test('only explicit source mode snaps, keeps exact API coordinate, and never calculates', async ({ page }) => {
  let snaps = 0, calculations = 0;
  await page.route('**/source-snap?*', route => { snaps++; return route.fulfill({ json: snap }); });
  page.on('request', request => { if (request.url().endsWith('/simulations')) calculations++; });
  await page.goto('/#model');
  await expect(page.locator('.reach-preview')).toBeVisible();
  await clickMap(page);
  expect(snaps).toBe(0);
  await arm(page);
  await expect(page.getByTestId('source-pick-status')).toContainText('75 м');
  await expect(page.getByTestId('source-pick-status')).toContainText(don.name);
  await clickMap(page);
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('432.125');
  await expect(page.locator('.reach-preview')).toHaveAttribute('data-source-coordinate', JSON.stringify(snap.coordinate));
  await expect(page.getByRole('button', { name: 'Отменить выбор источника' })).toHaveCount(0);
  await clickMap(page);
  expect(snaps).toBe(1);
  expect(calculations).toBe(0);
});

test('far clicks, final 100m and malformed replies keep the previous source', async ({ page }) => {
  let reply: unknown = snap;
  await page.route('**/source-snap?*', route => route.fulfill({ json: reply }));
  await page.goto('/#model');
  await page.getByLabel('Положение сценарного источника, м').fill('100');
  for (const invalid of [{ ...snap, distance_to_river_m: 76 }, { ...snap, source_distance_m: 901 }, { ...snap, reach_id: other.id }, { ...snap, coordinate: [400, 52] }, { ...snap, max_distance_m: 100 }]) {
    reply = invalid;
    await arm(page); await clickMap(page);
    await expect(page.getByTestId('source-pick-status')).toContainText(/далеко|100 м|Некорректный/);
    await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('100');
    await page.getByRole('button', { name: 'Отменить выбор источника' }).click();
  }
});

test('cancel, Escape, numeric edits and reach changes invalidate delayed snap responses', async ({ page }) => {
  let release!: () => void;
  let requested = 0;
  await page.route('**/source-snap?*', async route => { requested++; await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: snap }).catch(() => {}); });
  await page.goto('/#model');
  for (const action of ['cancel', 'escape', 'numeric', 'reach']) {
    await arm(page); await clickMap(page);
    await expect.poll(() => requested).toBeGreaterThan(0);
    if (action === 'cancel') await page.getByRole('button', { name: 'Отменить выбор источника' }).click();
    if (action === 'escape') await page.keyboard.press('Escape');
    if (action === 'numeric') await page.getByLabel('Положение сценарного источника, м').fill('125');
    if (action === 'reach') await page.getByLabel('Подготовленный участок').selectOption(other.id);
    release(); await page.waitForTimeout(100);
    await expect(page.getByLabel('Положение сценарного источника, м')).not.toHaveValue(String(snap.source_distance_m));
    if (action === 'cancel' || action === 'escape') await expect(page.getByRole('button', { name: 'Указать источник на карте', exact: true })).toBeFocused();
    if (await page.getByRole('button', { name: 'Отменить выбор источника' }).count()) await page.keyboard.press('Escape');
    requested = 0;
  }
});

test('numeric source and keyboard range reach both allowed extremes', async ({ page }) => {
  await page.goto('/#model');
  const input = page.getByLabel('Положение сценарного источника, м');
  const slider = page.getByRole('slider', { name: 'Переместить сценарный источник вдоль русла' });
  await slider.focus(); await page.keyboard.press('End');
  await expect(input).toHaveValue('900');
  await slider.press('Home'); await expect(input).toHaveValue('0');
  await input.fill('901'); await expect(page.getByRole('button', { name: 'Рассчитать', exact: true })).toBeDisabled();
  await input.fill('900'); await expect(page.getByRole('button', { name: 'Рассчитать', exact: true })).toBeEnabled();
});

test('draft river preview keeps the completed result and A/B geometry immutable', async ({ page }) => {
  await page.route('**/source-snap?*', route => route.fulfill({ json: { ...snap, reach_id: other.id } }));
  await page.goto('/#model');
  await page.getByRole('button', { name: 'Запустить демонстрацию' }).click();
  const path = await page.locator('.simulation-segment').first().getAttribute('d');
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await page.getByLabel('Подготовленный участок').selectOption(other.id);
  await expect(page.locator('.reach-preview')).toHaveAttribute('data-reach-id', other.id);
  await expect(page.locator('.map-topline')).toContainText(other.name);
  await expect(page.locator('.comparison-notice')).toContainText('одинаковые участок');
  await expect(page.locator('.simulation-stale')).toBeVisible();
  await page.getByRole('button', { name: 'Показать рассчитанный результат', exact: true }).click();
  await expect(page.locator('.simulation-map-label')).toHaveText(don.name);
  const shape = lineShape((await page.locator('.simulation-segment').first().getAttribute('d'))!);
  lineShape(path!).forEach((value, index) => expect(shape[index]).toBeCloseTo(value, 2));
  await expect(page.getByLabel('Время от начала сценария')).toBeEnabled();
  await page.locator('.simulation-segment').first().dispatchEvent('click');
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('0');
});

test('numeric preview follows the same WGS84 distance as the real Don API', async ({ page, request }) => {
  await page.unroute('**/api/v1/river-reaches');
  const catalog = await (await request.get('/api/v1/river-reaches')).json();
  const actual = catalog.items.find((item: { id: string }) => item.id === don.id);
  const distance = actual.length_m * .4321;
  await page.goto('/#model');
  await page.getByLabel('Положение сценарного источника, м').fill(String(distance));
  const [longitude, latitude] = JSON.parse((await page.locator('.reach-preview').getAttribute('data-source-coordinate'))!);
  const answer = await request.post('/api/v1/simulations', { data: { river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10, effluent_mg_l: 100, velocity_m_s: .25, dispersion_m2_s: 5, duration_hours: .1, reach_id: don.id, source_distance_m: distance } });
  expect(answer.ok()).toBeTruthy();
  const point = await answer.json();
  expect(Math.abs(point.source_coordinate[0] - longitude)).toBeLessThan(1e-10);
  expect(Math.abs(point.source_coordinate[1] - latitude)).toBeLessThan(1e-10);
});

test('mobile source mode exposes the map, supports Escape and keeps the timeline', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#model');
  await arm(page);
  await expect(page.locator('#model-parameters')).not.toBeVisible();
  await expect(page.locator('.reach-preview')).not.toHaveAttribute('inert', '');
  await expect(page.getByLabel('Выбранный участок и сценарный источник')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Отменить выбор источника' })).toBeInViewport();
  await expect(page.getByLabel('Время от начала сценария')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Параметры', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

for (const width of [1280, 375]) for (const load of ['continuous', 'finite']) {
  test(`real pilot last 100m renders a two-vertex result safely at ${width}px with ${load} load`, async ({ page, request }) => {
    await page.unroute('**/api/v1/river-reaches');
    await page.unroute('**/api/v1/simulations');
    await page.setViewportSize({ width, height: 812 });
    const catalog = await (await request.get('/api/v1/river-reaches')).json();
    const pilot = catalog.items.find((item: { id: string }) => item.id === 'voronezh-zheltye-peski');
    expect(pilot).toBeTruthy();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/#model');
    await openParameters(page);
    await page.getByLabel('Подготовленный участок').selectOption(pilot.id);
    await page.getByLabel('Положение сценарного источника, м').fill(String(pilot.length_m - 100));
    await page.getByLabel('Длительность, ч').fill('.1');
    await page.getByLabel('Режим нагрузки', { exact: true }).selectOption(load);
    if (load === 'finite') await page.getByLabel('Период загрязнения, ч').fill('.05');
    const response = page.waitForResponse(answer => answer.url().endsWith('/api/v1/simulations'));
    await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    const answer = await response;
    expect(answer.ok()).toBeTruthy();
    const data = await answer.json();
    expect(data.geometry.coordinates).toHaveLength(2);
    await page.waitForTimeout(100);
    expect(errors).toEqual([]);
    await expect(page.locator('.simulation-segment')).toHaveCount(100);
    await expect(page.locator('.simulation-arrow')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
    await expect(page.getByLabel('Время от начала сценария')).toBeEnabled();
  });
}
