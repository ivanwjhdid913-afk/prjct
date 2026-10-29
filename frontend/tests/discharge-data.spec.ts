import { expect, test } from '@playwright/test';

const source = { id: 'primary', title: 'Первичный документ', publisher: 'Издатель', url: 'https://example.org/report', published_on: null, publication_note: 'День публикации не установлен', checked_on: '2026-10-30', document_id: 'report-2022', sha256: null, acquisition: 'Открыть документ', redistribution: 'Только ссылка' };
const keys = ['outfall_position','channel','river_flow','effluent_flow','background','substance_load','time_regime','velocity_dispersion','observations'];
function dataset() { return { format_version: 1, checked_on: '2026-10-30', sources: [{ ...source }], items: [{ id: 'examined', name: 'Исследованный объект', kind: 'Очистные сооружения', location_description: 'Липецк', receiver: 'Воронеж', receiver_note: 'Приёмник в документе', discharge_summary: 'Исторические сведения, текущий выпуск не установлен', coordinates: null as any, evidence: [{ source_id: 'primary', locator: 'стр. 47, табл. 1.2', statement: 'Хлориды на выходе, январь', period: '2022, январь', quantity: { parameter: 'Хлориды', value: 127, unit: 'мг/дм³', basis: 'actual', scope: 'Выход очистных сооружений' }, conversion: '1 мг/дм³ = 1 мг/л; месячное значение не задаёт временной режим' }], missing: ['Координаты выпуска','Синхронные расход и фон'], readiness: 'insufficient', readiness_reason: 'Не хватает положения выпуска и гидрологии', prepared_reach: { status: 'not_established', reach_id: null, explanation: 'Не сопоставлен с подготовленными участками; ближайший участок не подставляется' }, matrix: Object.fromEntries(keys.map(key => [key, { status: key === 'substance_load' ? 'partial' : 'missing', note: key === 'substance_load' ? 'Есть месячные хлориды' : 'Не опубликовано', source_ids: ['primary'] }])) }] }; }
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 720 }); await page.route('https://tile.openstreetmap.org/**', route => route.abort()); });

test('read-only catalog shows provenance, limitations and no invented markers or calculation', async ({ page }) => {
  await page.route('**/api/v1/discharge-data', route => route.fulfill({ json: dataset() }));
  let calculations = 0; page.on('request', request => { if (request.url().endsWith('/simulations')) calculations++; });
  await page.goto('/'); await page.getByRole('link', { name: 'Исходные данные' }).click();
  await expect(page.getByRole('heading', { name: 'Данные о водных сбросах', exact: true })).toBeVisible();
  await page.getByTestId('discharge-card').first().locator('summary').click();
  await expect(page.getByTestId('discharge-card')).toContainText('стр. 47, табл. 1.2');
  await expect(page.getByTestId('discharge-card')).toContainText('127');
  await expect(page.getByTestId('discharge-card')).toContainText('мг/дм³');
  await expect(page.getByTestId('discharge-card')).toContainText('2022, январь');
  await expect(page.getByText('Координаты не установлены', { exact: true })).toBeVisible();
  await expect(page.locator('.discharge-marker')).toHaveCount(0);
  await expect(page.getByTestId('discharge-card').getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Матрица наличия данных' })).toContainText('Нет данных');
  await expect(page.getByRole('link', { name: 'Первичный документ', exact: true }).first()).toHaveAttribute('rel', /noopener/);
  expect(calculations).toBe(0);
});

test('loading and unavailable catalog can retry without breaking ordinary scenario mode', async ({ page }) => {
  let release!: () => void;
  await page.route('**/api/v1/discharge-data', async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ status: 503, json: { detail: 'temporarily unavailable' } }); });
  await page.goto('/#discharge-data');
  await expect(page.getByText('Загружаем паспорта данных…', { exact: true })).toBeVisible();
  await expect.poll(() => !!release).toBeTruthy(); release();
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить');
  await page.route('**/api/v1/discharge-data', route => route.fulfill({ json: dataset() }));
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(page.getByTestId('discharge-card')).toHaveCount(1);
  await page.getByRole('link', { name: 'Моделирование', exact: true }).click();
  await page.getByRole('button', { name: 'Запустить демонстрацию', exact: true }).click();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
});

test('empty catalog has no fabricated objects', async ({ page }) => {
  await page.route('**/api/v1/discharge-data', route => route.fulfill({ json: { ...dataset(), items: [] } }));
  await page.goto('/#discharge-data'); await expect(page.getByText('Паспортов пока нет', { exact: true })).toBeVisible();
  await expect(page.locator('.discharge-marker')).toHaveCount(0);
});

test('enterprise coordinates are explicitly distinct from an outfall and never populate model conditions', async ({ page }) => {
  const data = dataset(); data.items[0].coordinates = { longitude: 39.6, latitude: 52.6, crs: 'EPSG:4326', kind: 'enterprise', description: 'Территория предприятия, не водовыпуск', source_id: 'primary', locator: 'Карта предприятия' };
  data.items.push({ ...structuredClone(data.items[0]), id: 'outfall', name: 'Проверенный выпуск', coordinates: { ...data.items[0].coordinates, longitude: 39.61, kind: 'outfall', description: 'Координаты выпуска из документа' } });
  await page.route('**/api/v1/discharge-data', route => route.fulfill({ json: data }));
  await page.goto('/#discharge-data');
  await expect(page.getByRole('button', { name: 'Территория предприятия: Исследованный объект', exact: true })).toHaveClass(/enterprise/);
  await expect(page.getByRole('button', { name: 'Водовыпуск: Проверенный выпуск', exact: true })).toHaveClass(/outfall/);
  await page.getByRole('button', { name: 'Территория предприятия: Исследованный объект', exact: true }).click();
  await expect(page.getByTestId('discharge-card').first()).toContainText('не водовыпуск');
  await page.getByRole('link', { name: 'Моделирование', exact: true }).click();
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('0');
  await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('100');
});

test('document text is literal and malicious source links are rejected', async ({ page }) => {
  const data = dataset(); data.items[0].name = '<img src=x onerror=alert(1)>';
  data.items[0].evidence[0].statement = '<script>fetch("https://untrusted.example")</script>';
  await page.route('**/api/v1/discharge-data', route => route.fulfill({ json: data }));
  await page.goto('/#discharge-data'); await page.getByTestId('discharge-card').locator('summary').click();
  await expect(page.getByText(data.items[0].evidence[0].statement, { exact: true })).toBeVisible();
  await expect(page.getByTestId('discharge-card').locator('img,script,iframe')).toHaveCount(0);
  data.sources[0].url = 'javascript:alert(1)';
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Некорректный набор');
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});

for (const kind of ['invalid-coordinate','bad-reference','bad-period','null-number','unknown-version','false-ready','unsupported-match','unsourced-data','invalid-evidence-period','array-kind','raw-url-control']) test(`invalid data is rejected: ${kind}`, async ({ page }) => {
  const data: any = dataset();
  if (kind === 'invalid-coordinate') data.items[0].coordinates = { longitude: 400, latitude: 52, crs: 'EPSG:4326', kind: 'enterprise', description: 'test', source_id: 'primary', locator: 'p1' };
  if (kind === 'bad-reference') data.items[0].evidence[0].source_id = 'missing';
  if (kind === 'bad-period') data.sources[0].checked_on = '2026-02-31';
  if (kind === 'null-number') data.items[0].evidence[0].quantity.value = null;
  if (kind === 'unknown-version') data.format_version = 2;
  if (kind === 'false-ready') data.items[0].readiness = 'ready';
  if (kind === 'unsupported-match') data.items[0].prepared_reach = { status: 'matched', reach_id: 'nonexistent', explanation: 'Непроверенное совпадение' };
  if (kind === 'unsourced-data') data.items[0].matrix.river_flow = { status: 'available', note: 'Заявлено без источника', source_ids: [] };
  if (kind === 'invalid-evidence-period') data.items[0].evidence[0].period = '2023–2022';
  if (kind === 'array-kind') data.items[0].coordinates = { longitude: 39.6, latitude: 52.6, crs: 'EPSG:4326', kind: ['enterprise'], description: 'Территория предприятия', source_id: 'primary', locator: 'p1' };
  if (kind === 'raw-url-control') data.sources[0].url = 'https://example.org/\nattack';
  await page.route('**/api/v1/discharge-data', route => route.fulfill({ json: data }));
  await page.goto('/#discharge-data'); await expect(page.getByRole('alert')).toContainText('Некорректный набор');
  await expect(page.locator('.discharge-marker')).toHaveCount(0);
});

test('phone catalog has readable cards and locally scrolling matrix without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.route('**/api/v1/discharge-data', route => route.fulfill({ json: dataset() }));
  await page.goto('/#discharge-data'); await page.getByTestId('discharge-card').first().locator('summary').click();
  await expect(page.getByTestId('discharge-card')).toContainText('Не хватает положения');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const matrix = page.getByRole('region', { name: 'Матрица наличия данных' });
  await matrix.focus(); await expect(matrix).toBeFocused();
  await page.keyboard.press('ArrowRight');
});

