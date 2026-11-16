import { expect, test, type Download, type Page } from '@playwright/test';
import { concentrationsAt, openParameters } from './model-helpers';

const api = process.env.SCENARIO_TEST_API;
test.skip(!api || !/^water_test_[a-f0-9]{32}$/.test(process.env.SCENARIO_TEST_DB ?? ''), 'Requires an isolated scenario API and database.');
test.use({ video: process.env.DISCHARGE_PASSPORT_MEDIA === '1' ? 'on' : 'off' });

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const proceed = (page: Page, endpoint: string) => page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST');

async function downloadText(download: Download) {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function openLibrary(page: Page) {
  await openParameters(page);
  const library = page.locator('.saved-scenarios');
  if (await library.getAttribute('open') === null) await library.locator(':scope > summary').click();
}

for (const width of [1280, 375]) test(`constant discharge passport, run, control point, saved and portable provenance at ${width}px`, async ({ page }, info) => {
  test.setTimeout(65_000);
  await page.setViewportSize({ width, height: width === 1280 ? 720 : 667 });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: api + url.pathname + url.search }) });
  });
  const media = process.env.DISCHARGE_PASSPORT_MEDIA === '1';
  let runs = 0;
  page.on('request', request => { if (request.url().endsWith('/simulations')) runs++; });
  await page.goto('/#discharge-data');
  await page.getByText('Условный источник на Дону', { exact: true }).click();
  const demo = page.getByRole('region', { name: 'Условный источник на Дону' });
  await expect(demo).toContainText('Проверьте условия перед применением');
  await expect(demo).toContainText('39,172956 / 53,0770544');
  await expect(demo).toContainText('Подготовленная геометрия');
  await expect(demo).toContainText('Постоянная нагрузка');
  if (media) await demo.screenshot({ path: info.outputPath(`passport-${width}.png`) });
  await demo.getByRole('button', { name: 'Применить условия' }).click();
  await expect(page).toHaveURL(/#model$/);
  await expect(page.getByText('Учебный паспорт · хлориды', { exact: true })).toBeVisible();
  const marker = page.getByRole('button', { name: 'Сценарный источник 1: Условный источник', exact: true });
  await expect(marker).toBeAttached();
  expect(runs).toBe(0);
  await openParameters(page);
  const calculation = proceed(page, '/simulations');
  await button(page, 'Рассчитать').click();
  const result = await calculation;
  expect(result.status()).toBe(200);
  const payload = await result.json();
  expect(payload.inputs.sources).toHaveLength(1);
  expect(payload.inputs.sources[0]).toMatchObject({ name: 'Условный источник', load_mode: 'continuous', effluent_flow_m3_s: 0.1, effluent_mg_l: 100 });
  expect(payload.source_coordinates[0].coordinate).toEqual([39.172956, 53.0770544]);
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  const point = page.getByRole('button', { name: 'Контрольная точка К1: Учебный створ ниже источника', exact: true });
  await point.click();
  const time = page.getByLabel('Время от начала сценария', { exact: true });
  await time.fill('0');
  await expect(page.getByTestId('temporal-current')).toHaveText('10,0000 мг/л');
  const path = page.locator('.simulation-segment').nth(45);
  const before = await path.getAttribute('stroke');
  await button(page, 'Воспроизвести').click();
  await expect.poll(async () => Number(await time.inputValue()), { timeout: 9000 }).toBeGreaterThan(0.8);
  await button(page, 'Пауза').click();
  await time.fill('1.5');
  const value = concentrationsAt(payload, 1.5)[45];
  expect(value).toBeGreaterThan(10.5);
  await expect(page.getByTestId('temporal-current')).toHaveText(`${value.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`);
  await expect(path).not.toHaveAttribute('stroke', before!);
  if (media) await page.screenshot({ path: info.outputPath(`control-${width}.png`) });

  await openLibrary(page);
  const name = `Учебный паспорт ${width} ${Date.now()}`;
  await page.getByLabel('Название сохраняемых условий').fill(name);
  const saving = proceed(page, '/scenarios');
  await button(page, 'Сохранить как новый сценарий').click();
  const savedResponse = await saving;
  expect(savedResponse.status()).toBe(201);
  const saved = await savedResponse.json();
  expect(saved.format_version).toBe(5);
  expect(saved.input_provenance).toMatchObject({ kind: 'synthetic', schema_version: 1, fields: { discharge_coordinates: { value: [39.172956, 53.0770544] }, load_mode: { value: 'continuous' } } });
  expect(saved.analysis_settings.points[0].segment_index).toBe(45);

  await page.reload();
  await openLibrary(page);
  await button(page, `Открыть «${name}»`).click();
  await expect(page.getByText('Происхождение параметров', { exact: true })).toBeVisible();
  if (media) await page.screenshot({ path: info.outputPath(`saved-${width}.png`) });
  expect(runs).toBe(1);
  const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Выгрузить текущие условия JSON').click()]);
  const exported = await downloadText(download);
  expect(JSON.parse(exported).input_provenance).toEqual(saved.input_provenance);
  const ce = page.getByLabel('Концентрация стоков выбранного источника ce, мг/л');
  await ce.fill('69');
  await expect(page.getByText('Условия отличаются от паспорта.', { exact: false })).toBeVisible();
  const [edited] = await Promise.all([page.waitForEvent('download'), button(page, 'Выгрузить текущие условия JSON').click()]);
  const editedDocument = JSON.parse(await downloadText(edited));
  expect(editedDocument.format_version).toBe(4);
  expect(editedDocument).not.toHaveProperty('input_provenance');
  await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: 'passport.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  const preview = page.getByTestId('conditions-preview');
  await expect(preview).toContainText('Совместимо с текущей моделью и геометрией.');
  await preview.getByText('Происхождение параметров из файла', { exact: true }).click();
  await expect(preview).toContainText('Синтетическое условие');
  if (media) await preview.screenshot({ path: info.outputPath(`file-preview-${width}.png`) });
  await button(page, 'Применить к форме').click();
  await expect(ce).toHaveValue('100');
  await expect(page.getByText('Происхождение параметров', { exact: true })).toBeVisible();
  expect(runs).toBe(1);

  await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: 'format4.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(editedDocument)) });
  await expect(preview).toContainText('Совместимо с текущей моделью и геометрией.');
  await expect(preview.getByText('Происхождение параметров из файла', { exact: true })).toHaveCount(0);
  await button(page, 'Применить к форме').click();
  await expect(ce).toHaveValue('69');
  await expect(page.getByText('Происхождение параметров', { exact: true })).toHaveCount(0);
  expect(runs).toBe(1);
});
