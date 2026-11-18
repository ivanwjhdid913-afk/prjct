import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { NETWORK_MODEL, draftFromInputs, inputsFromDraft, sampleSeries, timeBracket, validNetworkResult, type NetworkInputs, type NetworkResult, type NetworkSaved, type RiverNetwork } from '../src/riverNetworkData';
import { riverCoordinate } from '../src/riverCoordinate';

const raw = JSON.parse(readFileSync(new URL('../../backend/data/networks/kuzminka-v1.json', import.meta.url), 'utf8'));
const network = { ...raw, geometry_sha256: raw.metadata.geometry_sha256 } as RiverNetwork;
const defaults: NetworkInputs = {
  network_id: network.id, geometry_sha256: network.geometry_sha256, background_mg_l: 10, duration_hours: 1.5,
  headwaters: [{ node_id: 'main-inlet', flow_m3_s: 8, concentration_mg_l: 10 }, { node_id: 'tributary-inlet', flow_m3_s: 2, concentration_mg_l: 10 }],
  hydraulics: network.reaches.map(reach => ({ reach_id: reach.id, velocity_m_s: .4, dispersion_m2_s: 1 })),
  source: { reach_id: 'voronezh-upstream', distance_m: network.reaches[0].length_m / 2, flow_m3_s: .5, concentration_mg_l: 100, load_duration_hours: 5 / 60 },
  provenance: { hydraulics: 'synthetic', load: 'synthetic' },
};
function resultFor(inputs = defaults): NetworkResult {
  const source = network.reaches.find(reach => reach.id === inputs.source.reach_id)!;
  return {
    model_id: NETWORK_MODEL, format_version: 1, network, inputs, times_hours: [0, .5, inputs.duration_hours], scale_mg_l: [10, 100],
    source_coordinate: riverCoordinate(source.geometry.coordinates, source.distances_m, inputs.source.distance_m),
    reaches: network.reaches.map(reach => ({
      id: reach.id, distances_m: [reach.length_m * .25, reach.length_m * .75],
      segment_geometries: [0, 1].map(index => ({ type: 'LineString', coordinates: [riverCoordinate(reach.geometry.coordinates, reach.distances_m, reach.length_m * index / 2), riverCoordinate(reach.geometry.coordinates, reach.distances_m, reach.length_m * (index + 1) / 2)] })),
      concentrations_mg_l: [[10, 10], [20, 30], [10, 20]], flows_m3_s: [8, 8.5],
    })), nodes: network.nodes.map(node => ({ id: node.id, flow_m3_s: 10, concentrations_mg_l: [10, 10, 10] })),
    balance_kg: { input: [0, 3, 3], output: [0, 1, 3], stored: [0, 2, 0], residual: [0, 0, 0] }, diagnostics: {},
  };
}
async function openNetwork(page: Page) {
  const records: NetworkSaved[] = [];
  let runs = 0;
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/water-bodies?*', route => route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0, catalog_total: 0 } }));
  await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/v1/river-networks/pilot', route => route.fulfill({ json: { network, defaults } }));
  await page.route('**/api/v1/river-networks/simulations', route => {
    runs++;
    return route.fulfill({ json: resultFor(route.request().postDataJSON()) });
  });
  await page.route('**/api/v1/river-networks/scenarios', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      const record = { ...body, id: 'saved-network-1', created_at: '2026-11-19T09:00:00Z', network_snapshot: network };
      records.push(record);
      return route.fulfill({ status: 201, json: record });
    }
    return route.fulfill({ json: { items: records, total: records.length } });
  });
  await page.route('**/api/v1/river-networks/scenarios/*', route => route.fulfill({ json: records[0] }));
  await page.goto('/#model/network');
  await expect(page.getByTestId('river-network-map')).toBeVisible();
  return () => runs;
}

test('sampling uses physical timestamps including irregular fractional endpoints', () => {
  expect(sampleSeries([10, 30, 50], timeBracket([0, .2, 1.5], .1))).toBe(20);
  expect(sampleSeries([10, 30, 50], timeBracket([0, .2, 1.5], 1.5))).toBe(50);
  expect(inputsFromDraft(draftFromInputs(defaults), network)).toEqual(defaults);
  expect(validNetworkResult(resultFor(), network, defaults)).toBe(true);
  expect(validNetworkResult({ ...resultFor(), times_hours: [0, .5, 1.4] }, network, defaults)).toBe(false);
  expect(validNetworkResult({ ...resultFor(), source_coordinate: [39, 53] }, network, defaults)).toBe(false);
});

test('directed river network opens its source controls and geographic map', async ({ page }) => {
  const runs = await openNetwork(page);
  await expect(page.getByRole('heading', { name: 'Речная сеть', exact: true })).toBeVisible();
  await expect(page.getByLabel('Участок источника', { exact: true })).toBeVisible();
  await expect(page.locator('[data-network-reach]')).toHaveCount(4);
  await expect(page.locator('.network-direction')).toHaveCount(4);
  expect(runs()).toBe(0);
  await page.getByRole('button', { name: 'Рассчитать сеть', exact: true }).click();
  await expect(page.getByTestId('river-network-time')).toBeEnabled();
  await page.getByTestId('river-network-time').fill('0.25');
  await expect(page.getByTestId('network-checkpoint-below')).toHaveAttribute('data-concentration-mg-l', '15');
  await expect(page.locator('[data-network-cell="voronezh-below:0"]')).toHaveAttribute('data-concentration-mg-l', '15');
  await expect(page.getByTestId('river-network-chart')).toContainText('15 мг/л');
  await page.getByLabel('Концентрация сброса', { exact: true }).fill('80');
  await expect(page.getByTestId('river-network-stale')).toBeVisible();
  await expect(page.getByTestId('network-checkpoint-below')).toHaveAttribute('data-concentration-mg-l', '15');
  await page.getByLabel('Учебный режим сброса').selectOption('continuous');
  await expect(page.getByLabel('Длительность сброса', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Рассчитать сеть', exact: true }).click();
  await expect(page.getByTestId('river-network-stale')).toHaveCount(0);
  await page.locator('summary').filter({ hasText: 'Сохранённые условия сети' }).click();
  await page.getByRole('button', { name: 'Сохранить условия сети', exact: true }).click();
  await expect(page.locator('.network-saved [role="status"]')).toContainText('Условия сохранены.');
  await page.getByLabel('Сохранённый сценарий сети').selectOption('saved-network-1');
  await page.getByLabel('Концентрация сброса', { exact: true }).fill('70');
  await page.getByRole('button', { name: 'Открыть условия сети', exact: true }).click();
  await expect(page.getByLabel('Концентрация сброса', { exact: true })).toHaveValue('80');
  expect(runs()).toBe(2);
});

test('phone retains geographic map and explicitly initiated playback with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openNetwork(page);
  await page.getByRole('button', { name: 'Рассчитать сеть', exact: true }).click();
  await expect(page.getByTestId('river-network-time')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Воспроизвести сеть', exact: true }).click();
  await expect.poll(async () => Number(await page.getByTestId('river-network-time').inputValue())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Приостановить воспроизведение сети', exact: true }).click();
  const before = await page.getByTestId('river-network-scale').textContent();
  await page.getByTestId('river-network-time').fill('1.5');
  await expect(page.getByTestId('river-network-scale')).toHaveText(before!);
});

test('cancellation and newer network results reject late work while edits never clamp source position', async ({ page }) => {
  await openNetwork(page);
  const input = page.getByLabel('Концентрация сброса', { exact: true });
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/river-networks/simulations', async route => {
    const inputs = route.request().postDataJSON() as NetworkInputs;
    if (inputs.source.concentration_mg_l === 100) await delayed;
    if (inputs.source.concentration_mg_l === 90) return route.fulfill({ status: 503, json: { detail: 'busy' } });
    await route.fulfill({ json: resultFor(inputs) }).catch(error => { if (inputs.source.concentration_mg_l !== 100) throw error; });
  });
  const started = page.waitForRequest(request => request.url().endsWith('/river-networks/simulations'));
  await page.getByRole('button', { name: 'Рассчитать сеть', exact: true }).click();
  await started;
  await page.getByRole('button', { name: 'Отменить расчёт', exact: true }).click();
  await input.fill('80');
  await page.getByRole('button', { name: 'Рассчитать сеть', exact: true }).click();
  await expect(page.getByTestId('river-network-time')).toBeEnabled();
  release();
  await expect(page.getByTestId('river-network-stale')).toHaveCount(0);
  await input.fill('90');
  await page.getByRole('button', { name: 'Рассчитать сеть', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('через несколько секунд');
  await expect(page.getByTestId('river-network-time')).toBeEnabled();
  await page.getByLabel('Положение источника', { exact: true }).fill('20000');
  await page.getByRole('button', { name: 'Рассчитать сеть', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Проверьте условия');
  await expect(page.getByLabel('Положение источника', { exact: true })).toHaveValue('20000');
});

test('a stalled pilot becomes retryable after its timeout', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/v1/river-networks/scenarios', route => route.fulfill({ json: { items: [], total: 0 } }));
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/river-networks/pilot', async route => {
    await delayed;
    await route.fulfill({ json: { network, defaults } }).catch(() => {});
  });
  const started = page.waitForRequest(request => request.url().endsWith('/river-networks/pilot'));
  await page.goto('/#model/network');
  await started;
  await page.clock.fastForward(30_001);
  await expect(page.getByRole('alert')).toContainText('30 секунд');
  await page.route('**/api/v1/river-networks/pilot', route => route.fulfill({ json: { network, defaults } }));
  await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  await expect(page.getByTestId('river-network-map')).toBeVisible();
  release();
});

test('a stalled saved list can be retried and selecting another scenario rejects the late load', async ({ page }) => {
  await openNetwork(page);
  await page.clock.install();
  await page.locator('summary').filter({ hasText: 'Сохранённые условия сети' }).click();
  let releaseList!: () => void;
  const stalledList = new Promise<void>(resolve => { releaseList = resolve; });
  await page.route('**/api/v1/river-networks/scenarios', async route => {
    await stalledList;
    await route.fulfill({ json: { items: [], total: 0 } }).catch(() => {});
  });
  const listStarted = page.waitForRequest(request => request.url().endsWith('/river-networks/scenarios'));
  await page.getByRole('button', { name: 'Обновить список условий' }).click();
  await listStarted;
  await page.clock.fastForward(30_001);
  await expect(page.locator('.network-saved [role="status"]')).toContainText('30 секунд');
  const records = ['a', 'b'].map((id, i): NetworkSaved => ({ id, name: `Условия ${id}`, model_id: NETWORK_MODEL, format_version: 1,
    conditions: { ...defaults, source: { ...defaults.source, concentration_mg_l: 20 + i * 40 } },
    network_snapshot: network, created_at: '2026-11-19T09:00:00Z' }));
  await page.route('**/api/v1/river-networks/scenarios', route => route.fulfill({ json: { items: records, total: 2 } }));
  await page.getByRole('button', { name: 'Обновить список условий' }).click();
  await expect(page.getByLabel('Сохранённый сценарий сети').locator('option')).toHaveCount(3);
  releaseList();
  let releaseLoad!: () => void;
  const stalledLoad = new Promise<void>(resolve => { releaseLoad = resolve; });
  await page.route('**/api/v1/river-networks/scenarios/a', async route => {
    await stalledLoad;
    await route.fulfill({ json: records[0] }).catch(() => {});
  });
  await page.getByLabel('Сохранённый сценарий сети').selectOption('a');
  const loadStarted = page.waitForRequest(request => request.url().endsWith('/river-networks/scenarios/a'));
  await page.getByRole('button', { name: 'Открыть условия сети' }).click();
  await loadStarted;
  const canceled = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/river-networks/scenarios/a') });
  await page.getByLabel('Сохранённый сценарий сети').selectOption('b');
  await canceled;
  await page.getByLabel('Название условий сети').fill('Мой черновик');
  releaseLoad();
  await expect(page.getByRole('button', { name: 'Открыть условия сети' })).toBeEnabled();
  await expect(page.getByLabel('Концентрация сброса', { exact: true })).toHaveValue('100');
  await expect(page.getByLabel('Название условий сети')).toHaveValue('Мой черновик');
});

test('older saved conditions load through bounded pages', async ({ page }) => {
  await openNetwork(page);
  const summaries = Array.from({ length: 51 }, (_, index) => ({ id: `saved-${index}`, name: `Условия ${index + 1}`, created_at: '2026-11-19T09:00:00Z' }));
  const pages: number[] = [];
  await page.route('**/api/v1/river-networks/scenarios*', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? 0);
    pages.push(offset);
    return route.fulfill({ json: { items: summaries.slice(offset, offset + 50), total: summaries.length } });
  });
  await page.locator('summary').filter({ hasText: 'Сохранённые условия сети' }).click();
  await page.getByRole('button', { name: 'Обновить список условий' }).click();
  await expect(page.getByLabel('Сохранённый сценарий сети').locator('option')).toHaveCount(51);
  await page.getByRole('button', { name: 'Ещё сохранённые', exact: true }).click();
  await expect(page.getByLabel('Сохранённый сценарий сети').locator('option')).toHaveCount(52);
  await page.getByLabel('Сохранённый сценарий сети').selectOption('saved-50');
  await expect(page.getByRole('button', { name: 'Ещё сохранённые', exact: true })).toHaveCount(0);
  expect(pages).toEqual([0, 50]);
});
