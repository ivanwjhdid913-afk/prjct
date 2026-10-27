import { expect, test, type Page, type Route } from '@playwright/test';
import { openParameters } from './model-helpers';

test.use({ baseURL: process.env.REQUEST_STATE_URL ?? 'http://127.0.0.1:5173' });

const don = { id: 'don-olkhovets', name: 'Дон · Ольховец', length_m: 1000, geometry: { type: 'LineString', coordinates: [[39.2, 52.5], [39.201, 52.502], [39.203, 52.501], [39.205, 52.503]] }, distances_m: [0, 300, 600, 1000], metadata: {} };
const other = { ...don, id: 'voronezh-zheltye-peski', name: 'Воронеж у Жёлтых Песков' };
const snap = { reach_id: don.id, source_distance_m: 432.125, coordinate: [39.2017, 52.5017], distance_to_river_m: 12, max_distance_m: 75 };
const answer = (payload: Record<string, number | string>) => ({
  inputs: { ...payload, length_m: 1000 - Number(payload.source_distance_m) },
  derived: { total_flow_m3_s: 10.1, area_m2: 10.1, load_kg_s: .01, excess_load_kg_s: .009, steady_mg_l: 11, travel_hours: 1 },
  distances_m: [125, 375], times_hours: [0, Number(payload.duration_hours) / 2, payload.duration_hours],
  concentrations_mg_l: [[10, 10], [12, 10], [14, 12]], scale_mg_l: [10, 14], geometry: don.geometry,
  reach_id: payload.reach_id, source_distance_m: payload.source_distance_m, source_coordinate: [39.2, 52.5],
  reach_metadata: { name: payload.reach_id === don.id ? don.name : other.name }, segment_geometries: [don.geometry, don.geometry],
});

async function deferCalculations(page: Page) {
  const pending: { route: Route; payload: Record<string, number | string>; release: () => void }[] = [];
  await page.route('**/api/v1/simulations', async route => {
    const payload = route.request().postDataJSON();
    await new Promise<void>(release => pending.push({ route, payload, release }));
    await route.fulfill({ json: answer(payload) }).catch(() => {});
  });
  return pending;
}

async function begin(page: Page) {
  await page.goto('/#model');
  await openParameters(page);
  await expect(page.getByLabel('Подготовленный участок')).toHaveValue(don.id);
  await page.getByLabel('Скорость течения u, м/с').fill('1');
  await page.getByLabel('Длительность, ч').fill('1');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
}
async function arm(page: Page) {
  await openParameters(page);
  await page.getByRole('button', { name: 'Указать источник на карте', exact: true }).click();
}
async function clickMap(page: Page) {
  await page.locator('.reach-preview .leaflet-container').click({ position: { x: 200, y: 200 } });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [don, other] } }));
});

test('late calculation leaves an armed map genuinely able to pick the source', async ({ page }) => {
  const pending = await deferCalculations(page);
  await page.route('**/source-snap?*', route => route.fulfill({ json: snap }));
  await begin(page);
  await expect.poll(() => pending.length).toBe(1);
  expect(pending[0].payload).toMatchObject({ reach_id: don.id, river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10, effluent_mg_l: 100, velocity_m_s: 1, dispersion_m2_s: 5, duration_hours: 1, load_mode: 'continuous' });
  await arm(page);
  pending[0].release();
  await expect(page.getByText('Выполняется расчёт…', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отменить выбор источника' })).toBeVisible();
  await expect(page.locator('.reach-preview')).toBeVisible();
  await clickMap(page);
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('432.125');
  await expect(page.locator('.simulation-stale')).toBeVisible();
});

for (const edit of ['numeric', 'reach'] as const) {
  test(`late calculation preserves ${edit} draft edits and the previous result identity`, async ({ page }) => {
    const pending = await deferCalculations(page);
    await begin(page);
    await expect.poll(() => pending.length).toBe(1);
    if (edit === 'numeric') await page.getByLabel('Положение сценарного источника, м').fill('125.5');
    else await page.getByLabel('Подготовленный участок').selectOption(other.id);
    pending[0].release();
    await expect(page.getByText('Выполняется расчёт…', { exact: false })).toHaveCount(0);
    await expect(page.locator('.reach-preview')).toBeVisible();
    await expect(page.locator('.reach-preview')).toHaveAttribute('data-reach-id', edit === 'reach' ? other.id : don.id);
    await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue(edit === 'numeric' ? '125.5' : '0');
    await expect(page.locator('.simulation-stale')).toBeVisible();
    await page.getByRole('button', { name: 'Показать рассчитанный результат', exact: true }).click();
    await expect(page.locator('.simulation-map-label')).toHaveText(don.name);
    await expect(page.locator('.simulation-stale')).toBeVisible();
  });
}

test('cancelled calculation and out-of-order repeated calculations never replace the newer result', async ({ page }) => {
  const pending = await deferCalculations(page);
  await begin(page);
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole('button', { name: 'Отменить ожидание' }).click();
  pending[0].release();
  await expect(page.getByText(/Ожидание отменено/)).toBeVisible();
  await expect(page.locator('.simulation-segment')).toHaveCount(0);
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  await page.getByLabel('Подготовленный участок').selectOption(other.id);
  await page.getByRole('button', { name: 'Запустить новый расчёт', exact: true }).click();
  await expect.poll(() => pending.length).toBe(3);
  pending[2].release();
  await expect(page.locator('.simulation-map-label')).toHaveText(other.name);
  pending[1].release();
  await page.waitForTimeout(100);
  await expect(page.locator('.simulation-map-label')).toHaveText(other.name);
  await expect(page.getByLabel('Подготовленный участок')).toHaveValue(other.id);
});

test('source-snap timeout retains the source, rejects a late reply and permits another pick', async ({ page }) => {
  await page.clock.install();
  const releases: (() => void)[] = [];
  await page.route('**/source-snap?*', async route => {
    const index = releases.length;
    await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ json: { ...snap, source_distance_m: index ? 300 : 432.125 } }).catch(() => {});
  });
  await page.goto('/#model');
  await page.getByLabel('Положение сценарного источника, м').fill('125.5');
  await arm(page); await clickMap(page);
  await expect.poll(() => releases.length).toBe(1);
  await page.clock.fastForward(10_001);
  await expect(page.getByTestId('source-pick-status')).toContainText(/время ожидания.*привязки/);
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('125.5');
  releases[0]();
  await page.waitForTimeout(30);
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('125.5');
  await clickMap(page);
  await expect.poll(() => releases.length).toBe(2);
  releases[1]();
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('300');
});

test('a failed snap keeps the previous source and a new calculation cancels pending snap replies', async ({ page }) => {
  const pending = await deferCalculations(page);
  let release!: () => void, snaps = 0;
  await page.route('**/source-snap?*', async route => {
    if (++snaps === 1) return route.fulfill({ status: 503, json: { detail: 'Unavailable' } });
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: snap }).catch(() => {});
  });
  await page.goto('/#model');
  await page.getByLabel('Положение сценарного источника, м').fill('125.5');
  await arm(page); await clickMap(page);
  await expect(page.getByTestId('source-pick-status')).toContainText('Не удалось привязать');
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('125.5');
  await clickMap(page);
  await expect.poll(() => snaps).toBe(2);
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  release(); pending[0].release();
  await expect(page.locator('.simulation-map-label')).toHaveText(don.name);
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('125.5');
  await expect(page.getByRole('button', { name: 'Отменить выбор источника' })).toHaveCount(0);
});
