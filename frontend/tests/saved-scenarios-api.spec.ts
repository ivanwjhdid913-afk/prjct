import { expect, test, type Page } from '@playwright/test';
import { openParameters } from './model-helpers';

// Never write test scenarios to the working database. The operator provisions
// a disposable run_tests-style DB and a separate backend before enabling this suite.
const api = process.env.SCENARIO_TEST_API;
const testDb = process.env.SCENARIO_TEST_DB ?? '';
test.skip(!api || !/^water_test_[0-9a-f]{32}$/.test(testDb), 'Requires a separate disposable scenario API/database.');
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url());
    return route.fetch({ url: `${api}${url.pathname}${url.search}` }).then(response => route.fulfill({ response }));
  });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
});
async function library(page: Page) {
  await openParameters(page);
  const details = page.locator('.saved-scenarios');
  if (!await details.getAttribute('open').then(value => value !== null)) await details.locator('summary').click();
}
async function save(page: Page, name: string) {
  await library(page); await page.getByLabel('Название сохраняемых условий').fill(name);
  const response = page.waitForResponse(r => r.url().endsWith('/scenarios') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Сохранить как новый сценарий', exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(201);
  const data = await actual.json();
  await expect(page.getByTestId('library-status')).toContainText('Сохранены');
  return data;
}
async function run(page: Page) {
  await openParameters(page);
  const response = page.waitForResponse(r => r.url().endsWith('/simulations'));
  await page.locator('.simulation-actions button[type="submit"]').click();
  const actual = await response; expect(actual.status()).toBe(200);
  const result = await actual.json();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  return result;
}
for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 667 }]) {
  test(`real database lifecycle, reload, explicit calculation and A/B ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let calculations = 0;
    page.on('request', r => { if (r.url().endsWith('/simulations')) calculations++; });
    await page.goto('/#model'); await openParameters(page);
    await page.getByLabel('Подготовленный участок').selectOption('voronezh-zheltye-peski');
    await page.getByLabel('Положение сценарного источника, м').fill('40.125');
    await page.getByLabel('Длительность, ч').fill('0.1');
    await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
    await page.getByLabel('Период загрязнения, ч').fill('0.001');
    const name = `Проверка ${viewport.width} ${Date.now()}`;
    const aSaved = await save(page, name);
    expect(aSaved.conditions).toMatchObject({ reach_id: 'voronezh-zheltye-peski', source_distance_m: 40.125, duration_hours: .1, load_mode: 'finite', load_duration_hours: .001 });
    expect(aSaved.geometry_sha256).toMatch(/^[0-9a-f]{64}$/);
    await page.reload(); await library(page);
    await page.getByRole('button', { name: `Открыть «${name}»`, exact: true }).click();
    await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('40.125');
    expect(calculations).toBe(0);
    const a = await run(page);
    expect(a.inputs.duration_hours).toBe(.1);
    await openParameters(page); await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
    await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
    await page.getByLabel('Концентрация стоков ce, мг/л').fill('50');
    const bName = `${name} Б`;
    const bSaved = await save(page, bName);
    expect(bSaved.id).not.toBe(aSaved.id);
    expect(bSaved.conditions.effluent_mg_l).toBe(50);
    await expect(page.locator('.simulation-stale')).toBeVisible();
    await page.getByLabel('Концентрация стоков ce, мг/л').fill('25');
    await page.getByRole('button', { name: `Открыть «${bName}»`, exact: true }).click();
    await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('50');
    expect(calculations).toBe(1);
    const b = await run(page);
    expect(a.inputs.effluent_mg_l).toBe(100); expect(b.inputs.effluent_mg_l).toBe(50);
    await expect(page.getByRole('button', { name: 'Показать А', exact: true })).toBeVisible();
    await page.getByLabel('Время от начала сценария').fill('0.01');
    await expect(page.getByTestId('comparison-a')).toBeVisible();
    await expect(page.getByTestId('comparison-b')).toBeVisible();
    await page.getByRole('button', { name: 'Показать А', exact: true }).click();
    await expect(page.getByLabel('Время от начала сценария')).toHaveValue('0.01');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}

for (const geometry of ['don-olkhovets', 'voronezh-zheltye-peski', 'synthetic']) {
  for (const load of ['continuous', 'finite']) {
    test(`server roundtrip through form: ${geometry}/${load}, fractional inputs and boundary source`, async ({ page }) => {
      await page.goto('/#model'); await openParameters(page);
      if (geometry === 'synthetic') {
        await page.getByLabel('Геометрия сценария').selectOption('synthetic');
        await page.getByLabel('Длина участка L, м').fill('500.125');
      } else {
        await page.getByLabel('Подготовленный участок').selectOption(geometry);
        const max = await page.getByLabel('Положение сценарного источника, м').getAttribute('max');
        await page.getByLabel('Положение сценарного источника, м').fill(max!);
      }
      await page.getByLabel('Длительность, ч').fill('.2');
      await page.getByLabel('Расход стоков q, м³/с').fill('.125');
      await page.getByLabel('Режим нагрузки', { exact: true }).selectOption(load);
      if (load === 'finite') await page.getByLabel('Период загрязнения, ч').fill('.001');
      const name = `${geometry}/${load}/${Date.now()}`;
      const saved = await save(page, name);
      await page.reload(); await library(page);
      await page.getByRole('button', { name: `Открыть «${name}»`, exact: true }).click();
      await expect(page.getByLabel('Длительность, ч')).toHaveValue('0.2');
      await expect(page.getByLabel('Расход стоков q, м³/с')).toHaveValue('0.125');
      await expect(page.getByLabel('Режим нагрузки', { exact: true })).toHaveValue(load);
      if (geometry === 'synthetic') await expect(page.getByLabel('Длина участка L, м')).toHaveValue('500.125');
      else await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue(String(saved.conditions.source_distance_m));
      await expect(page.locator('.simulation-segment')).toHaveCount(0);
    });
  }
}
