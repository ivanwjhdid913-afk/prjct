import { expect, test } from '@playwright/test';
import { openParameters, openProfile } from './model-helpers';

test.beforeEach(async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
});

test('runs the actual conservative model and uses its profile on the map', async ({ page }) => {
  await page.goto('/#model');
  await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длительность, ч').fill('24');
  await expect(page.getByRole('heading', { name: 'Моделирование', exact: true })).toBeVisible();
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  await expect(page.locator('.map-topline')).toContainText('Синтетическая геометрия');
  await expect(page.locator('.simulation-segment')).toHaveCount(data.distances_m.length);
  await expect(page.getByTestId('selected-concentration')).toHaveText('10,0000 мг/л');
  const scale = await page.getByTestId('concentration-scale').innerText();
  const timeIndex = data.times_hours.findIndex((value: number) => value >= 6);
  await page.getByLabel('Время от начала сценария').fill(String(data.times_hours[timeIndex]));
  await page.getByLabel('Расчётный сегмент').selectOption('20');
  const values: number[] = data.concentrations_mg_l[timeIndex];
  const expected = values[20];
  expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(.5);
  await expect(page.getByTestId('selected-concentration')).toHaveText(`${expected.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`);
  await expect(page.locator('.simulation-segment').nth(20)).toHaveAttribute('data-concentration', String(expected));
  await expect(page.getByTestId('concentration-scale')).toHaveText(scale, { useInnerText: true });
  await openProfile(page);
  await page.getByText('Таблица профиля', { exact: true }).click();
  await expect(page.getByRole('table', { name: 'Рассчитанный профиль' }).locator('tbody tr')).toHaveCount(data.distances_m.length);
  const mapValues = await page.locator('.simulation-segment').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-concentration'))));
  expect(mapValues).toEqual(values);
  const tableValues = await page.getByRole('table', { name: 'Рассчитанный профиль' }).locator('tbody tr td:last-child').allTextContents();
  expect(tableValues).toEqual(values.map(value => value.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })));
  const profile = await page.locator('.simulation-profile polyline').getAttribute('points');
  const profileValues = profile!.split(' ').map(point => {
    const y = Number(point.split(',')[1]);
    return data.scale_mg_l[0] + (190 - y) * (data.scale_mg_l[1] - data.scale_mg_l[0]) / 160;
  });
  profileValues.forEach((value, index) => expect(value).toBeCloseTo(values[index], 12));
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('200');
  await expect(page.getByText('Параметры изменены. Результат относится к предыдущим условиям.', { exact: true })).toBeVisible();
});

test('preserves catalog filters when visiting the model', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Название объекта').fill('озеро');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.locator('.water-row')).toHaveCount(1);
  await page.getByRole('link', { name: 'Моделирование', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Моделирование', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Каталог', exact: true }).click();
  await expect(page.getByLabel('Название объекта')).toHaveValue('озеро');
  await expect(page.locator('.water-row')).toHaveCount(1);
});

test('shows a failed calculation and allows retry', async ({ page }) => {
  let attempt = 0;
  await page.route('**/api/v1/simulations', route => ++attempt === 1 ? route.fulfill({ status: 503, json: { detail: 'Unavailable' } }) : route.continue());
  await page.goto('/#model');
  await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длительность, ч').fill('24');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось выполнить расчёт');
  await page.getByRole('button', { name: 'Повторить расчёт', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
});

test('marks an in-flight result stale after inputs change', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/simulations', async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/#model');
  await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длительность, ч').fill('24');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByText('Выполняется расчёт…', { exact: true })).toBeVisible();
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('200');
  release();
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  await expect(page.getByText('Параметры изменены. Результат относится к предыдущим условиям.', { exact: true })).toBeVisible();
});

for (const cancel of [false, true]) {
  test(cancel ? 'cancels waiting and ignores a late response after the next calculation' : 'a late older response cannot overwrite a newer calculation', async ({ page }) => {
    // Deliberately ignore AbortSignal: the request-generation guard must work
    // even when a transport has already completed or cannot be cancelled.
    await page.addInitScript(() => {
      const originalFetch = window.fetch;
      window.fetch = async (input, init) => {
        if (String(input).endsWith('/api/v1/simulations')) {
          const response = await originalFetch(input, { ...init, signal: undefined });
          document.documentElement.dataset.completedSimulations = String(Number(document.documentElement.dataset.completedSimulations ?? 0) + 1);
          return response;
        }
        return originalFetch(input, init);
      };
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let firstCalculated!: () => void;
    const firstReady = new Promise<void>(resolve => { firstCalculated = resolve; });
    let attempts = 0;
    await page.route('**/api/v1/simulations', async route => {
      const first = ++attempts === 1;
      const response = await route.fetch();
      if (first) { firstCalculated(); await gate; }
      await route.fulfill({ response });
    });
    await page.goto('/#model');
    await openParameters(page);
    await page.getByLabel('Геометрия сценария').selectOption('synthetic');
    await page.getByLabel('Длительность, ч').fill('24');
    await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    await expect(page.getByText('Выполняется расчёт…', { exact: true })).toBeVisible();
    await firstReady;
    if (cancel) {
      await page.getByRole('button', { name: 'Отменить ожидание' }).click();
      await expect(page.getByText('Ожидание отменено. Сервер может ещё завершать вычисление.', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toHaveCount(0);
    }
    await page.getByLabel('Концентрация стоков ce, мг/л').fill('200');
    const newerResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/simulations') && response.request().postDataJSON().effluent_mg_l === 200);
    await page.getByRole('button', { name: cancel ? 'Рассчитать' : 'Запустить новый расчёт', exact: true }).click();
    const data = await (await newerResponse).json();
    await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
    release();
    await expect(page.locator('html')).toHaveAttribute('data-completed-simulations', '2');
    await openProfile(page);
    await page.getByText('Параметры показанного расчёта', { exact: true }).click();
    await expect(page.locator('.simulation-used-inputs dl div').filter({ hasText: 'Концентрация стоков ce, мг/л' }).locator('dd')).toHaveText('200,000');
    await expect(page.getByText('Параметры изменены. Результат относится к предыдущим условиям.', { exact: true })).toHaveCount(0);
    await expect(page.locator('.simulation-summary dd').last()).toHaveText(`${data.derived.steady_mg_l.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`);
  });
}

test('shows field errors returned by API and rejects malformed results', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/v1/simulations', route => ++attempts === 1
    ? route.fulfill({ status: 422, json: { detail: [{ loc: ['body', 'velocity_m_s'], msg: 'Invalid value' }] } })
    : route.fulfill({ json: { inputs: {}, concentrations_mg_l: [] } }));
  await page.goto('/#model');
  await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длительность, ч').fill('24');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Проверьте параметры расчёта.');
  await expect(page.getByLabel('Скорость течения u, м/с')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Проверьте значение и допустимый диапазон.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить расчёт', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер вернул неполные результаты.');
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toHaveCount(0);
});

test('zero-source calculation shows a uniform legend matching every segment', async ({ page }) => {
  await page.goto('/#model');
  await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длительность, ч').fill('24');
  await page.getByLabel('Расход стоков q, м³/с').fill('0');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  await page.getByLabel('Время от начала сценария').press('End');
  const scale = page.getByTestId('concentration-scale');
  await expect(scale).toContainText('Концентрация одинакова на всём участке');
  const background = await scale.locator('.simulation-gradient').evaluate(element => getComputedStyle(element).backgroundImage);
  expect(background).toBe('none');
  await expect(page.getByTestId('selected-concentration')).toHaveText('10,0000 мг/л');
  const colors = await page.locator('.simulation-segment').evaluateAll(elements => elements.map(element => element.getAttribute('stroke')));
  expect(new Set(colors).size).toBe(1);
});

for (const width of [375, 768, 1024, 1440]) {
  test(`model fits ${width}px and exposes keyboard controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#model');
    await openParameters(page);
    await page.getByLabel('Геометрия сценария').selectOption('synthetic');
    await page.getByLabel('Длительность, ч').fill('24');
    await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByLabel('Расчётный сегмент').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByLabel('Расчётный сегмент')).toHaveValue('1');
    await page.screenshot({ path: `test-results/simulation-${width}.png`, fullPage: true });
  });
}
