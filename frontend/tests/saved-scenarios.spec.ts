import { expect, test, type Page } from '@playwright/test';
import { openParameters } from './model-helpers';

const model = 'conservative-1d-advection-dispersion-v1';
const id = '00000000-0000-4000-8000-000000000001';
const conditions = { river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10, effluent_mg_l: 50, velocity_m_s: .25, dispersion_m2_s: 5, length_m: 500, duration_hours: .1, load_mode: 'finite', load_duration_hours: .001 };
const saved = { id, name: 'Короткий период', format_version: 1, model_id: model, geometry_mode: 'synthetic', geometry_version: 'synthetic-wgs84-meridian-v1', geometry_sha256: null, conditions, reach_name: 'Синтетический участок', load_mode: 'finite', created_at: '2026-10-27T12:00:00Z', compatibility: { compatible: true, reasons: [] } };
async function library(page: Page) {
  await openParameters(page);
  await page.getByText('Сохранённые условия', { exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/scenarios?*', route => route.fulfill({ json: { items: [saved], total: 1, limit: 20, offset: 0 } }));
  await page.route(`**/api/v1/scenarios/${id}`, route => route.fulfill({ json: saved }));
});

test('opens conditions without calculating and saves edited form as a new immutable record', async ({ page }) => {
  let calculations = 0;
  page.on('request', request => { if (request.url().endsWith('/simulations')) calculations++; });
  await page.route('**/api/v1/scenarios', route => route.fulfill({ status: 201, json: { ...saved, ...route.request().postDataJSON(), id: '00000000-0000-4000-8000-000000000002' } }));
  await page.goto('/#model'); await library(page);
  await page.getByRole('button', { name: 'Открыть «Короткий период»', exact: true }).click();
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('synthetic');
  await expect(page.getByLabel('Длительность, ч')).toHaveValue('0.1');
  await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('50');
  expect(calculations).toBe(0);
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('25.125');
  await page.getByLabel('Название сохраняемых условий').fill('Новый вариант');
  const post = page.waitForRequest(r => r.url().endsWith('/scenarios') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Сохранить как новый сценарий', exact: true }).click();
  expect((await post).postDataJSON()).toEqual({ name: 'Новый вариант', format_version: 1, model_id: model, geometry_version: 'synthetic-wgs84-meridian-v1', geometry_sha256: null, conditions: { ...conditions, effluent_mg_l: 25.125 } });
  await expect(page.getByTestId('library-status')).toContainText('Сохранены');
  await expect(page.getByText(/массивы концентраций.*не сохраняются/i)).toBeVisible();
});

test('database errors never report success and permit retry', async ({ page }) => {
  await page.route('**/api/v1/scenarios', route => route.fulfill({ status: 503, json: { detail: 'База данных временно недоступна.' } }));
  await page.goto('/#model'); await library(page);
  await page.getByRole('button', { name: 'Открыть «Короткий период»' }).click();
  await page.getByLabel('Название сохраняемых условий').fill('Ошибка');
  await page.getByRole('button', { name: 'Сохранить как новый сценарий', exact: true }).click();
  await expect(page.getByTestId('library-error')).toContainText('База данных');
  await expect(page.getByTestId('library-status')).not.toContainText('Сохранены');
  await expect(page.getByRole('button', { name: 'Сохранить как новый сценарий', exact: true })).toBeEnabled();
});

for (const reason of ['Геометрия участка изменилась.', 'Участок удалён.', 'Версия модели не поддерживается.', 'Версия формата не поддерживается.']) {
  test(`incompatible record remains accessible without restoring form: ${reason}`, async ({ page }) => {
    await page.route(`**/api/v1/scenarios/${id}`, route => route.fulfill({ json: { ...saved, compatibility: { compatible: false, reasons: [reason] } } }));
    await page.goto('/#model'); await library(page);
    await page.getByRole('button', { name: 'Открыть «Короткий период»' }).click();
    await expect(page.getByTestId('library-error')).toContainText(reason);
    await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
    await expect(page.getByRole('button', { name: 'Открыть «Короткий период»' })).toBeVisible();
  });
}

test('late open cannot replace edits made while waiting', async ({ page }) => {
  await page.addInitScript(() => { const fetch = window.fetch; window.fetch = (input, options) => fetch(input, typeof input === 'string' && input.includes('/scenarios/') ? { ...options, signal: undefined } : options); });
  let release!: () => void;
  await page.route(`**/api/v1/scenarios/${id}`, async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: saved }); });
  await page.goto('/#model'); await library(page);
  await page.getByRole('button', { name: 'Открыть «Короткий период»' }).click();
  await expect.poll(() => !!release).toBeTruthy();
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('123');
  release();
  await expect(page.getByTestId('library-error')).toContainText('изменены');
  await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('123');
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
});

test('empty or incomplete form is rejected without posting a record', async ({ page }) => {
  let writes = 0;
  page.on('request', r => { if (r.url().endsWith('/scenarios') && r.method() === 'POST') writes++; });
  await page.goto('/#model'); await library(page);
  await page.getByLabel('Название сохраняемых условий').fill('Незавершённый');
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('');
  await page.getByRole('button', { name: 'Сохранить как новый сценарий', exact: true }).click();
  await expect(page.getByTestId('library-error')).toContainText('условия');
  expect(writes).toBe(0);
});

test('list is paginated and supports retry without opening a large permanent table', async ({ page }) => {
  const urls: string[] = [];
  await page.route('**/api/v1/scenarios?*', route => { urls.push(route.request().url()); return route.fulfill({ json: { items: [saved], total: 21, limit: 20, offset: new URL(route.request().url()).searchParams.get('offset') === '20' ? 20 : 0 } }); });
  await page.goto('/#model'); await library(page);
  await page.getByRole('button', { name: 'Следующие сохранённые условия' }).click();
  await expect.poll(() => urls.some(url => url.includes('offset=20'))).toBeTruthy();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('button', { name: 'Предыдущие сохранённые условия' }).click();
  await expect(page.getByText('1–1 из 21', { exact: true })).toBeVisible();
});

test('opening a delayed variant respects A pinned while the record was loading', async ({ page }) => {
  let release!: () => void;
  await page.route(`**/api/v1/scenarios/${id}`, async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: saved }); });
  await page.goto('/#model'); await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длина участка L, м').fill('500');
  await page.getByLabel('Длительность, ч').fill('.1');
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
  await page.getByLabel('Период загрязнения, ч').fill('.001');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  await library(page);
  await page.getByRole('button', { name: 'Открыть «Короткий период»', exact: true }).click();
  await expect.poll(() => !!release).toBeTruthy();
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  release();
  await expect(page.getByRole('button', { name: 'Рассчитать Б', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Показать А', exact: true })).toBeVisible();
});

test('a cancelled open ignores a late response and can be retried', async ({ page }) => {
  await page.addInitScript(() => { const fetch = window.fetch; window.fetch = (input, options) => fetch(input, typeof input === 'string' && input.includes('/scenarios/') ? { ...options, signal: undefined } : options); });
  let release!: () => void;
  await page.route(`**/api/v1/scenarios/${id}`, async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: saved }); });
  await page.goto('/#model'); await library(page);
  await page.getByRole('button', { name: 'Открыть «Короткий период»', exact: true }).click();
  await expect.poll(() => !!release).toBeTruthy();
  await page.getByRole('button', { name: 'Отменить ожидание библиотеки', exact: true }).click();
  release();
  await expect(page.getByTestId('library-status')).toContainText('отменено');
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
  await page.route(`**/api/v1/scenarios/${id}`, route => route.fulfill({ json: saved }));
  await page.getByRole('button', { name: 'Открыть «Короткий период»', exact: true }).click();
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('synthetic');
});

test('Enter in the saved name saves conditions instead of submitting a calculation', async ({ page }) => {
  let calculations = 0, saves = 0;
  page.on('request', request => { if (request.url().endsWith('/simulations')) calculations++; });
  await page.route('**/api/v1/scenarios', route => { saves++; return route.fulfill({ status: 201, json: { ...saved, ...route.request().postDataJSON() } }); });
  await page.goto('/#model'); await library(page);
  await page.getByRole('button', { name: 'Открыть «Короткий период»', exact: true }).click();
  await expect(page.getByTestId('library-status')).toContainText('Открыты условия');
  await expect(page.getByRole('button', { name: 'Сохранить как новый сценарий', exact: true })).toBeEnabled();
  await page.getByLabel('Название сохраняемых условий').fill('Вариант с клавиатуры');
  await page.getByLabel('Название сохраняемых условий').press('Enter');
  await expect.poll(() => saves).toBe(1);
  expect(calculations).toBe(0);
});
