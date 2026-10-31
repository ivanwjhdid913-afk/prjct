import { expect, test, type Page } from '@playwright/test';
import { openParameters, openProfile } from './model-helpers';

test.use({ baseURL: process.env.LOAD_PROFILE_UI_URL ?? 'http://127.0.0.1:5173' });

async function add(page: Page, start: string, end: string, ce: string, index: number) {
  await page.getByRole('button', { name: 'Добавить период', exact: true }).click();
  await page.getByLabel(`Начало периода ${index}, ч`, { exact: true }).fill(start);
  await page.getByLabel(`Конец периода ${index}, ч`, { exact: true }).fill(end);
  await page.getByLabel(`Концентрация периода ${index}, мг/л`, { exact: true }).fill(ce);
}
async function prepare(page: Page) {
  await page.goto('/#model'); await openParameters(page);
  await expect(page.getByRole('option', { name: 'График концентрации стоков', exact: true })).toHaveCount(1);
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('profile');
  await page.getByLabel('Длительность, ч').fill('6');
  await add(page, '0', '.5', '100', 1); await add(page, '2', '2.5', '60', 2);
}
async function run(page: Page) {
  const pending = page.waitForResponse(response => response.url().endsWith('/simulations'));
  await page.locator('.simulation-actions button[type=submit]').click();
  const response = await pending; expect(response.ok()).toBeTruthy();
  const result = await response.json(); await expect(page.locator('.simulation-segment')).toHaveCount(100); return result;
}
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 720 }); await page.route('https://tile.openstreetmap.org/**', route => route.abort()); });

test('editor shows the source step graph before an explicit real calculation and preserves result forcing after edits', async ({ page }) => {
  let requests = 0; page.on('request', req => { if (req.url().endsWith('/simulations')) requests++; });
  await prepare(page);
  await expect(page.locator('.load-settings').getByTestId('source-load-chart')).toBeVisible(); expect(requests).toBe(0);
  const result = await run(page);
  expect(result.inputs.load_intervals).toEqual([{ start_hours: 0, end_hours: .5, effluent_mg_l: 100 }, { start_hours: 2, end_hours: 2.5, effluent_mg_l: 60 }]);
  await page.getByLabel('Время от начала сценария').fill('2.25');
  await expect(page.getByTestId('source-status')).toContainText('60');
  expect(await page.getByTestId('load-end-marker').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('data-hour'))))).toEqual([0,.5,2,2.5]);
  await page.getByLabel('Концентрация периода 2, мг/л', { exact: true }).fill('30');
  await expect(page.locator('.simulation-stale')).toBeVisible();
  await expect(page.getByTestId('source-status')).toContainText('60');
  await page.getByLabel('Время от начала сценария').fill('1');
  await expect(page.getByTestId('source-status')).toContainText('10');
  expect(requests).toBe(1);
  await openProfile(page); await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await expect(page.getByTestId('temporal-current')).toBeVisible();
});

test('overlap errors identify the row, block calculation and are not silently sorted or clamped', async ({ page }) => {
  await prepare(page); await page.getByLabel('Начало периода 2, ч', { exact: true }).fill('.25');
  await expect(page.getByLabel('Начало периода 2, ч', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  let requests = 0; page.on('request', req => { if (req.url().endsWith('/simulations')) requests++; });
  await page.locator('.simulation-actions button[type=submit]').click();
  await expect(page.getByLabel('Начало периода 2, ч', { exact: true })).toHaveValue('.25');
  expect(requests).toBe(0);
  await page.getByLabel('Начало периода 2, ч', { exact: true }).fill('.5');
  await expect(page.getByLabel('Начало периода 2, ч', { exact: true })).not.toHaveAttribute('aria-invalid','true');
});

test('different profiles compare at one physical time without changing pinned A or its events', async ({ page }) => {
  await prepare(page); const a = await run(page);
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await page.getByLabel('Концентрация периода 2, мг/л', { exact: true }).fill('30');
  const b = await run(page);
  expect(a.inputs.load_intervals[1].effluent_mg_l).toBe(60); expect(b.inputs.load_intervals[1].effluent_mg_l).toBe(30);
  await page.getByLabel('Время от начала сценария').fill('2.25');
  await expect(page.getByTestId('source-status')).toContainText('А:'); await expect(page.getByTestId('source-status')).toContainText('Б:');
  const scale = await page.getByTestId('concentration-scale').innerText();
  const map = await page.locator('.simulation-map .leaflet-map-pane').getAttribute('style');
  for (const name of ['Показать А','Показать Б']) {
    await page.getByRole('button', { name, exact:true }).click();
    await expect(page.getByLabel('Время от начала сценария')).toHaveValue('2.25');
    await expect(page.getByTestId('concentration-scale')).toHaveText(scale,{useInnerText:true});
    expect(await page.locator('.simulation-map .leaflet-map-pane').getAttribute('style')).toBe(map);
  }
});

test('editing the profile during a pending calculation keeps the completed snapshot visibly stale', async ({ page }) => {
  await prepare(page);
  let release!:()=>void; let payload:any;
  await page.route('**/api/v1/simulations', async route => { payload=route.request().postDataJSON(); await new Promise<void>(resolve=>{release=resolve;}); const response = await route.fetch(); await route.fulfill({response}); });
  const pending = page.waitForResponse(response=>response.url().endsWith('/simulations'));
  await page.locator('.simulation-actions button[type=submit]').click(); await expect.poll(()=>!!release).toBeTruthy();
  await page.getByLabel('Концентрация периода 2, мг/л', { exact:true }).fill('30'); release();
  const result = await (await pending).json(); expect(result.inputs.load_intervals).toEqual(payload.load_intervals);
  await expect(page.locator('.simulation-stale')).toBeVisible();
  await page.getByLabel('Время от начала сценария').fill('2.25'); await expect(page.getByTestId('source-status')).toContainText('60');
});

test('phone editor and saved source chart keep keyboard focus and physical time accessible', async ({ page }) => {
  await page.setViewportSize({width:375,height:667}); await prepare(page);
  await page.getByRole('button',{name:'Добавить период',exact:true}).focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Начало периода 3, ч',{exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Удалить период 3',exact:true}).click();
  const result=await run(page); expect(result.inputs.load_intervals).toHaveLength(2);
  await expect(page.getByRole('button',{name:'Воспроизвести',exact:true})).toBeVisible();
  await page.getByLabel('Время от начала сценария').focus(); await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('blank profile background stays blank and cannot draw an invented zero or launch a request', async ({ page }) => {
  await prepare(page);
  let requests = 0; page.on('request', request => { if (request.url().endsWith('/simulations')) requests++; });
  await page.getByLabel('Фоновая концентрация cb, мг/л', { exact: true }).fill('');
  await expect(page.locator('.load-settings').getByTestId('source-load-chart')).toHaveCount(0);
  await page.locator('.simulation-actions button[type=submit]').click();
  await expect(page.getByLabel('Фоновая концентрация cb, мг/л', { exact: true })).toHaveValue('');
  expect(requests).toBe(0);
});

for (const hiddenScalar of ['-1', '']) test(`profile calculation/save/export ignore preserved legacy scalar draft ${JSON.stringify(hiddenScalar)}`, async ({ page }) => {
  let calculation: any; let savedPayload: any;
  await page.route('**/api/v1/simulations', route => {
    calculation = route.request().postDataJSON();
    return route.fulfill({ json: { inputs: calculation, format_version: 2, model_id: 'conservative-1d-advection-dispersion-v1',
      derived: { total_flow_m3_s: 10.1, area_m2: 40.4, load_kg_s: null, excess_load_kg_s: null, steady_mg_l: null, travel_hours: 1 },
      distances_m: [125,375], times_hours: [0,6], concentrations_mg_l: [[10,10],[11,11]], scale_mg_l: [10,11],
      geometry: { type: 'LineString', coordinates: [[39,52],[39.001,52.001],[39.002,52.002]] } } });
  });
  await page.route('**/api/v1/scenarios?*', route => route.fulfill({ json: { items: [], total: 0, limit: 20, offset: 0 } }));
  await page.route('**/api/v1/scenarios', route => {
    savedPayload = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { ...savedPayload, id: '11111111-1111-4111-8111-111111111111',
      geometry_mode: 'synthetic', reach_name: 'Синтетический участок', load_mode: 'profile',
      created_at: '2026-10-31T00:00:00Z', compatibility: { compatible: true, reasons: [] } } });
  });
  await page.goto('/#model'); await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длина участка L, м').fill('500'); await page.getByLabel('Длительность, ч').fill('6');
  await page.getByLabel('Концентрация стоков ce, мг/л', { exact: true }).fill(hiddenScalar);
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('profile');
  await add(page,'0','.5','100',1);
  await expect(page.locator('.load-settings').getByTestId('source-load-chart')).toBeVisible();
  await page.locator('.simulation-actions button[type=submit]').click();
  await expect.poll(() => calculation?.effluent_mg_l).toBeNull();
  await expect(page.locator('.simulation-segment')).toHaveCount(2);
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await openParameters(page);
  await page.locator('.saved-scenarios > summary').click();
  await page.getByLabel('Название сохраняемых условий').fill('Сохранённый профиль');
  await page.getByRole('button', { name: 'Сохранить как новый сценарий', exact: true }).click();
  await expect.poll(() => savedPayload?.conditions.effluent_mg_l).toBeNull();
  await expect(page.getByTestId('library-status')).toContainText('Сохранены условия');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Выгрузить текущие условия JSON', exact: true }).click();
  const download = await pending, stream = await download.createReadStream(), parts: Buffer[] = [];
  for await (const part of stream!) parts.push(Buffer.from(part));
  const document = JSON.parse(Buffer.concat(parts).toString('utf8'));
  expect(document.conditions.effluent_mg_l).toBeNull();
  expect(document.conditions.load_intervals).toEqual(calculation.load_intervals);
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('continuous');
  await expect(page.getByLabel('Концентрация стоков ce, мг/л', { exact: true })).toHaveValue(hiddenScalar);
});
