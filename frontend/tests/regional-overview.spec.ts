import { expect, test, type Page } from '@playwright/test';

test.use({ baseURL: process.env.REGIONAL_UI_TEST_URL ?? 'http://127.0.0.1:5184' });

const reach = { id: 'don-olkhovets', name: 'Дон · Ольховец', length_m: 1000, geometry: { type: 'LineString', coordinates: [[39.2, 52.5], [39.21, 52.51]] }, distances_m: [0, 1000], metadata: {} };
const source = { id: 'osm', name: 'OpenStreetMap', url: 'https://www.openstreetmap.org', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors', obtained_on: '2026-11-02', raw_sha256: 'a'.repeat(64) };
const props = (id: string, name: string, kind: string, prepared_reach_ids: string[] = []) => ({ id, name, kind, source_id: source.id, source_elements: [{ type: 'way', id: 1 }], prepared_reach_ids, limitation: kind === 'river' ? 'Подготовленного участка нет; топология не проверена.' : 'Текущий одномерный речной решатель к водоёму не подключён.' });
const fixture = { type: 'FeatureCollection', metadata: { format_version: 1, name: 'Поверхностные воды Липецкой области', obtained_on: '2026-11-02', crs: 'EPSG:4326', coordinate_order: 'longitude, latitude', coverage_note: 'Выборочный обзор, не полная инвентаризация.', sources: [source], preparation: {} }, features: [
  { type: 'Feature', properties: props('boundary', 'Липецкая область', 'boundary'), geometry: { type: 'Polygon', coordinates: [[[38, 52], [40.5, 52], [40.5, 54], [38, 54], [38, 52]]] } },
  { type: 'Feature', properties: props('don', 'Дон', 'river', [reach.id]), geometry: reach.geometry },
  { type: 'Feature', properties: props('river-unprepared', 'Сосна', 'river'), geometry: { type: 'MultiLineString', coordinates: [[[38.5, 52.4], [38.8, 52.6]], [[39, 52.7], [39.2, 52.9]]] } },
  { type: 'Feature', properties: props('lake', 'Озеро Долгое', 'lake'), geometry: { type: 'Polygon', coordinates: [[[39.4, 52.7], [39.5, 52.7], [39.5, 52.8], [39.4, 52.7]]] } },
] };

async function open(page: Page) {
  let overviewLoads = 0, reachLoads = 0;
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/regional-overview', route => { overviewLoads++; return route.fulfill({ json: fixture }); });
  await page.route('**/api/v1/river-reaches', route => { reachLoads++; return route.fulfill({ json: { items: [reach] } }); });
  await page.goto('/tests/regional-harness.html');
  return () => ({ overviewLoads, reachLoads });
}

test('search and object selection show a passport; applying is a separate action and data is reused', async ({ page }) => {
  const counts = await open(page);
  await page.getByTestId('regional-search').fill('Дон');
  await page.getByRole('button', { name: 'Дон · Река · Есть подготовленный участок', exact: true }).click();
  const card = page.getByTestId('regional-object-card');
  await expect(card).toContainText('OpenStreetMap');
  await expect(page.getByTestId('applied-reach')).toBeEmpty();
  await card.getByRole('button', { name: 'К выбранному участку', exact: true }).click();
  await expect(page.getByTestId('applied-reach')).toHaveText(reach.id);
  await page.getByRole('button', { name: 'Вернуться к результату', exact: true }).click();
  await expect(page.getByTestId('regional-overview')).toBeHidden();
  await page.getByRole('button', { name: 'Переключить обзор' }).click();
  await expect(card).toBeVisible();
  expect(counts()).toEqual({ overviewLoads: 1, reachLoads: 1 });
});

test('unsupported water body and unprepared river remain informative without an apply action', async ({ page }) => {
  await open(page);
  await page.getByTestId('regional-search').fill('Долгое');
  await page.getByRole('button', { name: 'Озеро Долгое · Озеро · Расчёт не подключён', exact: true }).click();
  await expect(page.getByTestId('regional-object-card')).toContainText('одномерный речной решатель');
  await expect(page.getByRole('button', { name: 'К выбранному участку', exact: true })).toHaveCount(0);
  await page.getByTestId('regional-search').fill('Сосна');
  await page.getByRole('button', { name: 'Сосна · Река · Только обзор', exact: true }).click();
  await expect(page.getByTestId('regional-object-card')).toContainText('топология не проверена');
  await expect(page.getByTestId('regional-load-status')).toContainText('Подложка недоступна');
  // Leaflet uses one SVG path with two Move commands, preserving the gap.
  const disconnected = page.locator('[data-regional-feature="river-unprepared"]');
  await expect(disconnected).toHaveCount(1);
  expect((await disconnected.getAttribute('d'))?.match(/M/g)).toHaveLength(2);
});

test('keyboard and mobile retain search, passport, map and return action without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.getByTestId('regional-search').fill('Дон');
  await page.getByTestId('regional-search').press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('regional-object-card')).toContainText('Дон');
  await expect(page.getByTestId('regional-map')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Вернуться к результату', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('malformed provenance and unsupported prepared-waterbody mappings are rejected with a recoverable error', async ({ page }) => {
  for (const badData of [
    { ...fixture, metadata: { ...fixture.metadata, sources: [{ ...source, raw_sha256: 'unverified' }] } },
    { ...fixture, metadata: { ...fixture.metadata, sources: [{ ...source, url: 'https://name:password@example.org' }] } },
    { ...fixture, metadata: { ...fixture.metadata, obtained_on: '2026-02-30' } },
    { ...fixture, features: fixture.features.filter(feature => feature.properties.kind !== 'boundary') },
    { ...fixture, features: fixture.features.map(feature => feature.properties.kind === 'lake' ? { ...feature, properties: { ...feature.properties, prepared_reach_ids: [reach.id] } } : feature) },
  ]) {
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    await page.route('**/api/v1/regional-overview', route => route.fulfill({ json: badData }));
    await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [reach] } }));
    await page.goto('/tests/regional-harness.html');
    await expect(page.getByTestId('regional-load-status')).toContainText('Не удалось открыть сохранённый обзор');
    await page.route('**/api/v1/regional-overview', route => route.fulfill({ json: fixture }));
    await page.getByRole('button', { name: 'Повторить загрузку' }).click();
    await expect(page.getByTestId('regional-load-status')).toContainText('3 водных объектов');
  }
});

test('map selection and rapid object changes never apply a reach implicitly', async ({ page }) => {
  await open(page);
  const card = page.getByTestId('regional-object-card');
  await page.locator('[data-regional-feature="boundary"]').dispatchEvent('click');
  await expect(card).toHaveCount(0);
  await page.locator('[data-regional-reach="don-olkhovets"]').dispatchEvent('click');
  await expect(card).toContainText('Дон');
  await expect(page.getByTestId('applied-reach')).toBeEmpty();
  await page.getByRole('button', { name: 'Озеро Долгое · Озеро · Расчёт не подключён', exact: true }).click();
  await page.getByRole('button', { name: 'Сосна · Река · Только обзор', exact: true }).click();
  await page.getByRole('button', { name: 'Дон · Река · Есть подготовленный участок', exact: true }).click();
  await expect(card).toContainText('Дон · Ольховец');
  await expect(page.getByTestId('applied-reach')).toBeEmpty();
  await page.getByLabel('Подготовленные участки', { exact: true }).uncheck();
  await expect(page.locator('[data-regional-reach]')).toHaveCount(0);
  await card.getByRole('button', { name: 'К выбранному участку', exact: true }).click();
  await expect(page.getByTestId('applied-reach')).toHaveText(reach.id);
});

test('untrusted object names remain literal text in Leaflet tooltips and the React passport', async ({ page }) => {
  const malicious = '<img src=x onerror="window.regionalInjected=true">';
  const document = { ...fixture, features: fixture.features.map(feature => feature.properties.id === 'don' ? { ...feature, properties: { ...feature.properties, name: malicious } } : feature) };
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/regional-overview', route => route.fulfill({ json: document }));
  await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [reach] } }));
  await page.goto('/tests/regional-harness.html');
  const water = page.locator('[data-regional-feature="don"]:not([data-regional-reach])');
  await page.getByRole('checkbox', { name: 'Подготовленные участки' }).uncheck();
  const point = await water.evaluate((element) => {
    const line = element as SVGPathElement;
    const center = line.getPointAtLength(line.getTotalLength() / 2).matrixTransform(line.getScreenCTM()!);
    return { x: center.x, y: center.y };
  });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.leaflet-tooltip')).toHaveText(malicious);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('regional-object-card')).toContainText(malicious);
  await expect(page.locator('.leaflet-tooltip img, [data-testid="regional-object-card"] img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { regionalInjected?: boolean }).regionalInjected)).toBeUndefined();
});
