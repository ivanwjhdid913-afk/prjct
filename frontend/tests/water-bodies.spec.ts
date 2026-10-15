import { expect, test } from '@playwright/test';

test('shows loading, then the real database records', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/water-bodies*', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('Загружаем водные объекты…')).toBeVisible();
  release();
  await expect(page.getByText('Учебная река № 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Учебное озеро № 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Учебное водохранилище № 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Синтетические данные', { exact: true })).toHaveCount(3);
});

test('shows an empty response', async ({ page }) => {
  await page.route('**/api/v1/water-bodies*', (route) => route.fulfill({
    json: { items: [], total: 0, catalog_total: 0, limit: 50, offset: 0 },
  }));
  await page.goto('/');
  await expect(page.getByText('В списке пока нет объектов')).toBeVisible();
});

test('explains a connection failure and retries', async ({ page }) => {
  await page.route('**/api/v1/water-bodies*', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить список');
  await page.unroute('**/api/v1/water-bodies*');
  await page.getByRole('button', { name: 'Попробовать снова' }).click();
  await expect(page.getByText('Учебная река № 1', { exact: true })).toBeVisible();
});

test('handles an unavailable database response', async ({ page }) => {
  await page.route('**/api/v1/water-bodies*', (route) => route.fulfill({ status: 503, json: { detail: 'База данных временно недоступна.' } }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
});

test('rejects an unexpected API payload without a blank screen', async ({ page }) => {
  await page.route('**/api/v1/water-bodies*', (route) => route.fulfill({ json: { items: 'invalid' } }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('pages through the list without labeling unmarked records synthetic', async ({ page }) => {
  await page.route('**/api/v1/water-bodies*', (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    return route.fulfill({ json: {
      items: [{ id: `test-${offset}`, name: `Контрольная запись ${offset}`, kind: 'river', is_synthetic: false }],
      total: 51, catalog_total: 51, limit: 50, offset,
    } });
  });
  await page.goto('/');
  await expect(page.getByText('Контрольная запись 0', { exact: true })).toBeVisible();
  await expect(page.getByText('Синтетические данные', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.getByText('Контрольная запись 50', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByText('Контрольная запись 0', { exact: true })).toBeVisible();
});

test('returns to the first page when the list shrinks during refresh', async ({ page }) => {
  let shrunk = false;
  await page.route('**/api/v1/water-bodies*', (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    return route.fulfill({ json: {
      items: shrunk && offset > 0 ? [] : [{ id: `test-${offset}`, name: `Оставшийся пример ${offset}`, kind: 'lake', is_synthetic: true }],
      total: shrunk ? 1 : 51, catalog_total: shrunk ? 1 : 51, limit: 50, offset,
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.getByText('Оставшийся пример 50', { exact: true })).toBeVisible();
  shrunk = true;
  await page.getByRole('button', { name: 'Обновить список' }).click();
  await expect(page.getByText('Оставшийся пример 0', { exact: true })).toBeVisible();
  await expect(page.getByText('Показано 1–1 из 1', { exact: true })).toBeVisible();
});

for (const width of [375, 768, 1024, 1440]) {
  test(`fits a ${width}px viewport and supports keyboard navigation`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.getByText('Учебная река № 1', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'К списку объектов' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Каталог', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Моделирование', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Обновить список' })).toBeFocused();
    expect(errors).toEqual([]);
    if (width === 375 || width === 1440) {
      await page.screenshot({ path: `test-results/register-${width}.png`, fullPage: true });
    }
  });
}
