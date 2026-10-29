import { expect, test, type Page } from '@playwright/test';
import { openParameters } from './model-helpers';

test.use({ baseURL: process.env.EXCHANGE_UI_URL ?? 'http://127.0.0.1:5173' });
const id = '00000000-0000-4000-8000-000000000009';
const inputs = { river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10, effluent_mg_l: 50, velocity_m_s: .25, dispersion_m2_s: 5, length_m: 500, duration_hours: .1, load_mode: 'finite', load_duration_hours: .001, reach_id: null, source_distance_m: 0 };
const document = { name: 'Условия переноса', format_version: 1, model_id: 'conservative-1d-advection-dispersion-v1', geometry_mode: 'synthetic', geometry_version: 'synthetic-wgs84-meridian-v1', geometry_sha256: null, downstream_geometry_sha256: null, reach_id: null, reach_name: 'Синтетический участок', geometry_source: {}, conditions: inputs };
const saved = { ...document, id, created_at: '2026-10-29T12:00:00Z', load_mode: 'finite', compatibility: { compatible: true, reasons: [] } };
async function library(page: Page) { await openParameters(page); const panel = page.locator('.saved-scenarios'); if (await panel.getAttribute('open') === null) await panel.locator('summary').click(); }
function answer(payload: any) { return { inputs: { ...payload, length_m: 1000 }, derived: { total_flow_m3_s: 10.1, area_m2: 40.4, load_kg_s: .01, excess_load_kg_s: .009, steady_mg_l: 11, travel_hours: 1 }, distances_m: [250, 750], times_hours: [0, payload.duration_hours], concentrations_mg_l: [[10, 10], [11, 11]], scale_mg_l: [10, 11], geometry: { type: 'LineString', coordinates: [[39, 52], [39.001, 52.001], [39.002, 52.002]] }, reach_id: payload.reach_id, source_distance_m: payload.source_distance_m, source_coordinate: [39, 52], reach_metadata: { name: 'Дон' }, segment_geometries: Array(2).fill({ type: 'LineString', coordinates: [[39, 52], [39.001, 52.001]] }) }; }
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/scenarios?*', route => route.fulfill({ json: { items: [saved], total: 1, limit: 20, offset: 0 } }));
  await page.route(`**/api/v1/scenarios/${id}`, route => route.fulfill({ json: saved }));
});

test('successful list reload after closing and reopening removes only the list error', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/v1/scenarios?*', route => ++attempts === 1 ? route.fulfill({ status: 503, json: { detail: 'Ошибка первой загрузки' } }) : route.fulfill({ json: { items: [saved], total: 1, limit: 20, offset: 0 } }));
  await page.goto('/#model'); await library(page);
  await expect(page.getByRole('alert')).toContainText('Ошибка первой загрузки');
  await page.locator('.saved-scenarios summary').click(); await library(page);
  await expect(page.getByRole('button', { name: 'Открыть «Условия переноса»', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a delayed open never cancels a newer calculation with the same form values', async ({ page }) => {
  await page.addInitScript(() => { const original = window.fetch; window.fetch = (input, options) => original(input, typeof input === 'string' && (input.includes('/scenarios/') || input.includes('/simulations')) ? { ...options, signal: undefined } : options); });
  let openReply!: () => void, calculationReply!: () => void;
  await page.route(`**/api/v1/scenarios/${id}`, async route => { await new Promise<void>(resolve => { openReply = resolve; }); await route.fulfill({ json: saved }); });
  await page.route('**/api/v1/simulations', async route => { await new Promise<void>(resolve => { calculationReply = resolve; }); await route.fulfill({ json: answer(route.request().postDataJSON()) }); });
  await page.goto('/#model'); await library(page);
  await page.getByRole('button', { name: 'Открыть «Условия переноса»', exact: true }).click();
  await expect.poll(() => !!openReply).toBeTruthy();
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect.poll(() => !!calculationReply).toBeTruthy();
  openReply();
  await expect(page.getByRole('alert')).toContainText('более новое действие');
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
  await expect(page.getByText('Выполняется расчёт…', { exact: false })).toBeVisible();
  calculationReply();
  await expect(page.locator('.simulation-segment')).toHaveCount(2);
});

test('JSON preview applies only explicitly without any calculation or database write', async ({ page }) => {
  let calculations = 0, writes = 0;
  page.on('request', request => { if (request.url().endsWith('/simulations')) calculations++; if (request.url().endsWith('/scenarios') && request.method() === 'POST') writes++; });
  await page.route('**/api/v1/scenario-files/validate', route => route.fulfill({ json: { document: route.request().postDataJSON(), compatibility: { compatible: true, reasons: [] } } }));
  await page.goto('/#model'); await library(page);
  await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: 'условия.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await expect(page.getByTestId('conditions-preview')).toContainText('Условия переноса');
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
  expect(calculations).toBe(0); expect(writes).toBe(0);
  await page.getByRole('button', { name: 'Применить к форме', exact: true }).click();
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('synthetic');
  await expect(page.getByLabel('Длительность, ч')).toHaveValue('0.1');
  await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('50');
  expect(calculations).toBe(0); expect(writes).toBe(0);
});

test('malformed and oversized files are rejected before server validation and keep the form', async ({ page }) => {
  let validations = 0;
  page.on('request', request => { if (request.url().includes('/scenario-files/validate')) validations++; });
  await page.goto('/#model'); await library(page);
  for (const content of ['{broken', ' '.repeat(8193)]) {
    await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: 'ошибка.json', mimeType: 'application/json', buffer: Buffer.from(content) });
    await expect(page.getByTestId('transfer-error')).toBeVisible();
    await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
    await expect(page.getByRole('button', { name: 'Применить к форме', exact: true })).toHaveCount(0);
  }
  expect(validations).toBe(0);
});

test('incompatible preview displays literal text and cannot apply or open file URLs', async ({ page }) => {
  const hostile = { ...document, name: '<img src=x onerror=alert(1)>', reach_name: 'https://untrusted.example/river', model_id: 'unknown-model' };
  await page.route('**/api/v1/scenario-files/validate', route => route.fulfill({ json: { document: hostile, compatibility: { compatible: false, reasons: ['Неизвестная модель.'] } } }));
  await page.goto('/#model'); await library(page);
  await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: 'несовместимо.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hostile)) });
  await expect(page.getByTestId('conditions-preview')).toContainText(hostile.name);
  await expect(page.getByTestId('conditions-preview')).toContainText('Неизвестная модель.');
  await expect(page.getByRole('button', { name: 'Применить к форме', exact: true })).toBeDisabled();
  await expect(page.getByTestId('conditions-preview').locator('img,a,script')).toHaveCount(0);
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
});

test('saved JSON export contains the saved snapshot rather than edited form fields', async ({ page }) => {
  await page.goto('/#model'); await library(page);
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('222');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Выгрузить JSON «Условия переноса»', exact: true }).click();
  const download = await pending;
  const stream = await download.createReadStream(); const parts: Buffer[] = []; for await (const part of stream!) parts.push(Buffer.from(part));
  const exported = JSON.parse(Buffer.concat(parts).toString('utf8'));
  expect(exported.conditions.effluent_mg_l).toBe(50);
  expect(exported).toEqual(document);
  expect(exported).not.toHaveProperty('concentrations_mg_l');
});

test('refreshing a successful list does not erase a separate save error', async ({ page }) => {
  await page.route('**/api/v1/scenarios', route => route.fulfill({ status: 503, json: { detail: 'Ошибка сохранения' } }));
  await page.goto('/#model'); await library(page);
  await page.getByLabel('Название сохраняемых условий').fill('Проверка ошибки');
  await page.getByRole('button', { name: 'Сохранить как новый сценарий', exact: true }).click();
  await expect(page.getByTestId('library-error')).toContainText('Ошибка сохранения');
  await page.getByRole('button', { name: 'Обновить список', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Открыть «Условия переноса»', exact: true })).toBeEnabled();
  await expect(page.getByTestId('library-error')).toContainText('Ошибка сохранения');
});

test('cancelling the file chooser leaves the form and completed preview unchanged', async ({ page }) => {
  await page.goto('/#model'); await library(page);
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('123');
  await page.getByLabel('Импортировать условия JSON').dispatchEvent('cancel');
  await expect(page.getByText('Выбор файла отменён. Условия формы не изменены.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('123');
  await expect(page.getByTestId('conditions-preview')).toHaveCount(0);
});

test('a newer action while file validation waits prevents applying the old preview', async ({ page }) => {
  let release!: () => void;
  await page.route('**/api/v1/scenario-files/validate', async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: { document, compatibility: { compatible: true, reasons: [] } } }); });
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: answer(route.request().postDataJSON()) }));
  await page.goto('/#model'); await library(page);
  await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: 'условия.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await expect.poll(() => !!release).toBeTruthy();
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.locator('.simulation-segment')).toHaveCount(2);
  release(); await expect(page.getByTestId('conditions-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Применить к форме', exact: true }).click();
  await expect(page.getByTestId('transfer-error')).toContainText('более новое действие');
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
});

test('invalid UTF-8 is rejected with a readable reason before validation', async ({ page }) => {
  await page.goto('/#model'); await library(page);
  await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: 'повреждение.json', mimeType: 'application/json', buffer: Buffer.from([0xc3, 0x28]) });
  await expect(page.getByTestId('transfer-error')).toContainText('UTF-8');
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
});
