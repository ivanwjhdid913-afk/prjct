import { expect, test } from '@playwright/test';

// Never send automated map requests to the public tile service.
test.beforeEach(async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
});

test('opens real observation points and preserves catalog conditions on return', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Название объекта').fill('  реК  ');
  await page.getByLabel('Тип объекта').selectOption('river');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.getByRole('button', { name: 'Учебная река № 1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Точки наблюдения', exact: true })).toBeVisible();
  await expect(page.getByText('Всего точек: 3 · Без координат: 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать точку: Учебная точка А', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText('39.25');
  await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText('52.75');
  await expect(page.getByRole('button', { name: 'Маркер: Учебная точка А', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Маркер: Учебная точка Б', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Выбрать точку: Учебная точка Б', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText('Учебная точка Б');
  const missing = page.getByRole('button', { name: 'Выбрать точку: Учебная точка без координат', exact: true });
  await missing.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText('Координаты не заданы');
  await expect(page.getByText('Подложка карты недоступна', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Вернуться к каталогу', exact: true }).click();
  await expect(page.getByLabel('Название объекта')).toHaveValue('реК');
  await expect(page.getByLabel('Тип объекта')).toHaveValue('river');
  await expect(page.locator('.water-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Учебная река № 1', exact: true })).toBeFocused();
});

const body = { id: 'e432f7c0-4cec-4583-9537-000000000001', name: 'Учебная река № 1' };
const firstPoint = { id: 'f432f7c0-4cec-4583-9537-000000000001', name: 'Первый пример', water_body_id: body.id, geometry: { type: 'Point', coordinates: [39.25, 52.75] }, is_synthetic: true, coordinate_source: 'Вымышленные координаты' };
const secondPoint = { ...firstPoint, id: 'f432f7c0-4cec-4583-9537-000000000002', name: 'Второй пример' };
const collectionUrl = `**/api/v1/water-bodies/${body.id}/observation-points`;

test('skip link keeps the current object screen', async ({ page }) => {
  await page.goto(`/#water-body/${body.id}`);
  const skip = page.getByRole('link', { name: 'К списку объектов', exact: true });
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#water-body/${body.id}$`));
  await expect(page.getByRole('heading', { name: 'Точки наблюдения', exact: true })).toBeVisible();
});

test('recovers the basemap after retry without losing selection', async ({ page }) => {
  await page.goto(`/#water-body/${body.id}`);
  await expect(page.getByText('Подложка карты недоступна', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать точку: Учебная точка А', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText('Учебная точка А');
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQxQAAAAASUVORK5CYII=', 'base64') }));
  await page.getByRole('button', { name: 'Повторить загрузку подложки' }).click();
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible();
  await expect(page.getByText('Подложка карты недоступна', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Маркер: Учебная точка А', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('keeps a list and detail when every point lacks coordinates', async ({ page }) => {
  const point = { ...firstPoint, geometry: null };
  await page.route(collectionUrl, route => route.fulfill({ json: { water_body: body, items: [point], total: 1 } }));
  await page.route(`**/api/v1/observation-points/${point.id}`, route => route.fulfill({ json: { ...point, water_body: body } }));
  await page.goto(`/#water-body/${body.id}`);
  await expect(page.getByText('Нет точек с координатами', { exact: true })).toBeVisible();
  await expect(page.getByText('Всего точек: 1 · Без координат: 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Выбрать точку: ${point.name}` }).click();
  await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText('Координаты не заданы');
  await expect(page.locator('.point-marker')).toHaveCount(0);
});

test('shows the real empty collection for the reservoir', async ({ page }) => {
  await page.goto('/#water-body/e432f7c0-4cec-4583-9537-000000000003');
  await expect(page.getByText('У этого объекта пока нет точек наблюдения.', { exact: true })).toBeVisible();
  await expect(page.getByText('Всего точек: 0 · Без координат: 0', { exact: true })).toBeVisible();
});

test('explains missing water body and supports return', async ({ page }) => {
  await page.goto('/#water-body/00000000-0000-4000-8000-000000000099');
  await expect(page.getByRole('alert')).toContainText('Запись не найдена');
  await page.getByRole('button', { name: 'Вернуться к каталогу' }).click();
  await expect(page.getByRole('heading', { name: 'Список объектов' })).toBeVisible();
});

test('retries a failed collection and a missing detail without hiding the list', async ({ page }) => {
  let attempts = 0;
  let detailAttempts = 0;
  await page.route(collectionUrl, route => ++attempts === 1
    ? route.fulfill({ status: 503, json: { detail: 'unavailable' } })
    : route.fulfill({ json: { water_body: body, items: [firstPoint], total: 1 } }));
  await page.route(`**/api/v1/observation-points/${firstPoint.id}`, route => ++detailAttempts === 1
    ? route.fulfill({ status: 404, json: { detail: 'missing' } })
    : route.fulfill({ json: { ...firstPoint, water_body: body } }));
  await page.goto(`/#water-body/${body.id}`);
  await expect(page.getByRole('heading', { name: 'Не удалось загрузить точки' })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить запрос точек' }).click();
  await page.getByRole('button', { name: `Выбрать точку: ${firstPoint.name}` }).click();
  await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText('Запись не найдена');
  await page.getByRole('button', { name: 'Повторить запрос сведений' }).click();
  await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText(firstPoint.name);
  await expect(page.getByRole('button', { name: `Выбрать точку: ${firstPoint.name}` })).toBeVisible();
});

test('does not present a truncated collection as the full set', async ({ page }) => {
  await page.route(collectionUrl, route => route.fulfill({ json: { water_body: body, items: [firstPoint], total: 2 } }));
  await page.goto(`/#water-body/${body.id}`);
  await expect(page.getByRole('alert')).toContainText('неполный или некорректный список');
  await expect(page.locator('.point-marker')).toHaveCount(0);
});

test('ignores old point details even if the old fetch cannot be aborted', async ({ page }) => {
  await page.route(collectionUrl, route => route.fulfill({ json: { water_body: body, items: [firstPoint, secondPoint], total: 2 } }));
  await page.route(`**/api/v1/observation-points/${secondPoint.id}`, route => route.fulfill({ json: { ...secondPoint, water_body: body } }));
  await page.addInitScript(({ firstPoint, body }) => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => String(input).endsWith(`/observation-points/${firstPoint.id}`)
      ? new Promise<Response>(resolve => {
        (window as unknown as { releaseDetail: () => void }).releaseDetail = () => resolve(new Response(JSON.stringify({ ...firstPoint, water_body: body }), { headers: { 'Content-Type': 'application/json' } }));
      }) : original(input, init);
  }, { firstPoint, body });
  await page.goto(`/#water-body/${body.id}`);
  await page.getByRole('button', { name: `Выбрать точку: ${firstPoint.name}` }).click();
  await expect(page.getByText('Загружаем сведения…')).toBeVisible();
  await page.getByRole('button', { name: `Выбрать точку: ${secondPoint.name}` }).click();
  const card = page.getByRole('region', { name: 'Сведения о точке' });
  await expect(card).toContainText(secondPoint.name);
  await page.evaluate(async () => {
    (window as unknown as { releaseDetail: () => void }).releaseDetail();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(card).toContainText(secondPoint.name);
  await expect(card).not.toContainText(firstPoint.name);
});

test('preserves the catalog page when returning from a point screen', async ({ page }) => {
  await page.route('**/api/v1/water-bodies?*', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    return route.fulfill({ json: { items: [{ ...body, name: `Страница ${offset}`, kind: 'river', is_synthetic: true }], total: 51, catalog_total: 51, limit: 50, offset } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.getByRole('button', { name: 'Страница 50', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Точки наблюдения', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Страница 50', exact: true })).toBeVisible();
  await expect(page.getByText('Показано 51–51 из 51', { exact: true })).toBeVisible();
});

for (const width of [375, 768, 1024, 1440]) {
  test(`point map supports keyboard selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#water-body/${body.id}`);
    const marker = page.getByRole('button', { name: 'Маркер: Учебная точка А', exact: true });
    await marker.focus();
    await page.keyboard.press('Enter');
    await expect(marker).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Сведения о точке' })).toContainText('Учебная точка А');
    await expect(page.getByRole('link', { name: 'OpenStreetMap', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/points-${width}.png`, fullPage: true });
  });
}
