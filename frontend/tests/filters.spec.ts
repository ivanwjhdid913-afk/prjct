import { expect, test } from '@playwright/test';

test('searches real Cyrillic records by Enter, combines kind and resets', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Название объекта').fill('  уЧЕБ  ');
  await page.getByLabel('Тип объекта').selectOption('lake');
  await page.getByLabel('Название объекта').press('Enter');
  await expect(page.getByText('Показано 1–1 из 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Учебное озеро № 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Учебная река № 1', { exact: true })).toHaveCount(0);
  await page.getByLabel('Название объекта').fill('РЕКА');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.getByText('Совпадений не найдено', { exact: true })).toBeVisible();
  await expect(page.getByText('Измените название или тип объекта либо сбросьте условия.')).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить условия', exact: true }).click();
  await expect(page.getByLabel('Название объекта')).toHaveValue('');
  await expect(page.getByLabel('Тип объекта')).toHaveValue('');
  await expect(page.getByText('Показано 1–3 из 3', { exact: true })).toBeVisible();
});

for (const [kind, name] of [['river', 'Учебная река № 1'], ['lake', 'Учебное озеро № 1'], ['reservoir', 'Учебное водохранилище № 1']]) {
  test(`filters real records by ${kind}`, async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Тип объекта').selectOption(kind);
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.locator('.water-row')).toHaveCount(1);
    await expect(page.getByText('Синтетические данные', { exact: true })).toHaveCount(1);
  });
}

test('retains applied conditions across pages and resets page when applying drafts', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  await page.route('**/api/v1/water-bodies*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const offset = Number(query.get('offset'));
    return route.fulfill({ json: { items: [{ id: 'example', name: `Страница ${offset}`, kind: 'lake', is_synthetic: true }], total: 51, catalog_total: 100, limit: 50, offset } });
  });
  await page.goto('/');
  await page.getByLabel('Название объекта').fill('  ОЗЕРО  ');
  await page.getByLabel('Тип объекта').selectOption('lake');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('q')).toBe('ОЗЕРО');
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.getByText('Страница 50', { exact: true })).toBeVisible();
  expect(queries.at(-1)?.get('q')).toBe('ОЗЕРО');
  expect(queries.at(-1)?.get('kind')).toBe('lake');
  await page.getByLabel('Название объекта').fill('река');
  await page.getByLabel('Тип объекта').selectOption('river');
  await page.getByRole('button', { name: 'Обновить список' }).click();
  await expect.poll(() => queries.length).toBeGreaterThan(3);
  expect(queries.at(-1)?.get('q')).toBe('ОЗЕРО');
  expect(queries.at(-1)?.get('offset')).toBe('50');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.getByText('Страница 0', { exact: true })).toBeVisible();
  expect(queries.at(-1)?.get('q')).toBe('река');
  expect(queries.at(-1)?.get('kind')).toBe('river');
  expect(queries.at(-1)?.get('offset')).toBe('0');
});

test('empty catalog stays distinct even with active conditions', async ({ page }) => {
  await page.route('**/api/v1/water-bodies*', (route) => route.fulfill({ json: { items: [], total: 0, catalog_total: 0, limit: 50, offset: 0 } }));
  await page.goto('/');
  await page.getByLabel('Название объекта').fill('озеро');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.getByText('В списке пока нет объектов', { exact: true })).toBeVisible();
  await expect(page.getByText('Совпадений не найдено', { exact: true })).toHaveCount(0);
});

test('a late old response cannot overwrite the new result even if abort is ignored', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      // Deliberately simulate a transport that cannot cancel an already pending response.
      if (String(input).includes('q=slow')) {
        return new Promise<Response>((resolve) => {
          (window as unknown as { releaseOldResponse: () => void }).releaseOldResponse = () => resolve(new Response(JSON.stringify({
            items: [{ id: 'old', name: 'Устаревший объект', kind: 'river', is_synthetic: true }], total: 1, catalog_total: 3, limit: 50, offset: 0,
          }), { headers: { 'Content-Type': 'application/json' } }));
        });
      }
      return originalFetch(input, init);
    };
  });
  await page.goto('/');
  await page.getByLabel('Название объекта').fill('slow');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.getByText('Загружаем водные объекты…')).toBeVisible();
  await page.getByLabel('Название объекта').fill('ОЗЕРО');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.getByText('Учебное озеро № 1', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    (window as unknown as { releaseOldResponse: () => void }).releaseOldResponse();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByText('Устаревший объект', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Учебное озеро № 1', { exact: true })).toBeVisible();
});
