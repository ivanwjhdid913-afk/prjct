import { expect, test, type Page } from '@playwright/test';

const numberText = (n: number) => `${n.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`;
async function demo(page: Page) {
  await page.goto('/#model');
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations'));
  await page.getByRole('button', { name: 'Запустить демонстрацию' }).click();
  const data = await (await response).json();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  return data;
}
async function variant(page: Page) {
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
}
async function runB(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations'));
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  const actual = await response;
  expect(actual.ok()).toBeTruthy();
  const data = await actual.json();
  await expect(page.getByRole('button', { name: 'Показать Б', exact: true })).toBeEnabled();
  return data;
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
});

test('identical A and B have zero difference and equal colors at shared fractional time', async ({ page }) => {
  const a = await demo(page);
  await variant(page);
  const b = await runB(page);
  for (const key of ['inputs', 'geometry', 'distances_m', 'times_hours', 'concentrations_mg_l', 'scale_mg_l']) expect(a[key]).toEqual(b[key]);
  await page.getByLabel('Время от начала сценария').fill('24.5');
  await page.getByLabel('Расчётный сегмент').selectOption('50');
  await expect(page.getByTestId('comparison-delta')).toHaveText('0,0000 мг/л');
  const colors = await page.locator('.simulation-segment').evaluateAll(nodes => nodes.map(n => n.getAttribute('stroke')));
  await page.getByRole('button', { name: 'Показать А', exact: true }).click();
  expect(await page.locator('.simulation-segment').evaluateAll(nodes => nodes.map(n => n.getAttribute('stroke')))).toEqual(colors);
  await expect(page.getByLabel('Время от начала сценария')).toHaveValue('24.5');
  await expect(page.getByLabel('Расчётный сегмент')).toHaveValue('50');
  await expect(page.getByText(/После перезагрузки страницы сценарии сбрасываются/)).toBeVisible();
});

test('halved effluent compares actual results without changing A, time or map and has two matching profiles', async ({ page }) => {
  const a = await demo(page);
  await variant(page);
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('50');
  const b = await runB(page);
  expect(b.inputs.effluent_mg_l).toBe(50);
  const scale = await page.getByTestId('concentration-scale').innerText();
  const initialColors = await page.locator('.simulation-segment').evaluateAll(nodes => nodes.map(n => n.getAttribute('stroke')));
  await page.getByRole('button', { name: 'Показать А', exact: true }).click();
  expect(await page.locator('.simulation-segment').evaluateAll(nodes => nodes.map(n => n.getAttribute('stroke')))).toEqual(initialColors);
  await page.getByLabel('Расчётный сегмент').selectOption('50');
  await page.getByRole('button', { name: 'Увеличить масштаб', exact: true }).click();
  const view = await page.locator('.simulation-map .leaflet-map-pane').getAttribute('style');
  const path = await page.locator('.simulation-segment').nth(50).getAttribute('d');
  for (const time of [12, 24, 36]) {
    await page.getByLabel('Время от начала сценария').fill(String(time));
    await expect(page.getByTestId('comparison-a')).toHaveText(numberText(a.concentrations_mg_l[time][50]));
    await expect(page.getByTestId('comparison-b')).toHaveText(numberText(b.concentrations_mg_l[time][50]));
    await expect(page.getByTestId('comparison-delta')).toHaveText(numberText(b.concentrations_mg_l[time][50] - a.concentrations_mg_l[time][50]));
    for (const name of ['Показать А', 'Показать Б']) {
      await page.getByRole('button', { name, exact: true }).click();
      expect(await page.locator('.simulation-segment').nth(50).getAttribute('d')).toBe(path);
      expect(await page.locator('.simulation-map .leaflet-map-pane').getAttribute('style')).toBe(view);
      await expect(page.getByLabel('Время от начала сценария')).toHaveValue(String(time));
      await expect(page.getByTestId('concentration-scale')).toHaveText(scale, { useInnerText: true });
      await expect(page.locator('.simulation-segment').nth(50)).toHaveAttribute('data-concentration', String((name === 'Показать А' ? a : b).concentrations_mg_l[time][50]));
    }
  }
  await page.getByRole('button', { name: 'Профиль и показатели', exact: true }).click();
  await expect(page.locator('.simulation-profile polyline')).toHaveCount(2);
  const minimum = Math.min(...a.scale_mg_l, ...b.scale_mg_l), maximum = Math.max(...a.scale_mg_l, ...b.scale_mg_l);
  for (const [id, data] of [['profile-a', a], ['profile-b', b]] as const) {
    const points = await page.getByTestId(id).getAttribute('points');
    points!.split(' ').forEach((point, i) => {
      expect(minimum + (190 - Number(point.split(',')[1])) * (maximum - minimum) / 160).toBeCloseTo(data.concentrations_mg_l[36][i], 10);
    });
  }
  await page.getByRole('button', { name: 'Закрыть профиль' }).click();
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('25');
  await expect(page.locator('.simulation-stale')).toContainText('Б');
  await expect(page.getByTestId('comparison-a')).toHaveText(numberText(a.concentrations_mg_l[36][50]));
  await expect(page.getByTestId('comparison-b')).toHaveText(numberText(b.concentrations_mg_l[36][50]));
});

test('B errors and cancellation preserve both completed results and reject late responses', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, typeof input === 'string' && input.includes('/simulations') ? { ...init, signal: undefined } : init);
  });
  await demo(page); await variant(page); const b = await runB(page);
  await page.getByLabel('Время от начала сценария').fill('24');
  const originalA = await page.getByTestId('comparison-a').innerText();
  const originalB = await page.getByTestId('comparison-b').innerText();
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('50');
  await page.route('**/api/v1/simulations', route => route.fulfill({ status: 503, json: { detail: 'busy' } }));
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось выполнить расчёт');
  await expect(page.getByTestId('comparison-a')).toHaveText(originalA);
  await expect(page.getByTestId('comparison-b')).toHaveText(originalB);
  await page.unroute('**/api/v1/simulations');
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/simulations', async route => {
    await wait;
    await route.fulfill({ json: { ...b, inputs: { ...b.inputs, effluent_mg_l: 50 } } });
  });
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить ожидание', exact: true }).click();
  const late = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations'));
  release(); await late;
  await expect(page.getByText(/Ожидание отменено/)).toBeVisible();
  await expect(page.locator('.simulation-stale')).toBeVisible();
  await expect(page.getByTestId('comparison-a')).toHaveText(originalA);
  await expect(page.getByTestId('comparison-b')).toHaveText(originalB);
});

test('incompatible duration exits comparison without deleting A and allows a single calculation', async ({ page }) => {
  await demo(page); await variant(page); await runB(page);
  await page.getByLabel('Длительность, ч').fill('3');
  await expect(page.getByText(/Сравнение отключено/)).toContainText('длительность');
  await expect(page.getByTestId('comparison-delta')).toHaveCount(0);
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.locator('.simulation-stale')).toHaveCount(0);
  await page.getByLabel('Длительность, ч').fill('4');
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  await expect(page.locator('.simulation-stale')).toHaveText('Параметры изменены. Результат относится к предыдущим условиям.');
  await expect(page.getByTestId('comparison-delta')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Рассчитать', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await expect(page.getByLabel('Длительность, ч')).toHaveValue('4');
  await expect(page.getByLabel('Концентрация стоков ce, мг/л')).toHaveValue('100');
});

test('geometry and source changes explain incompatibility while A remains recoverable', async ({ page }) => {
  await demo(page); await variant(page); await runB(page);
  await page.getByLabel('Положение сценарного источника, м').fill('100');
  await expect(page.getByText(/Сравнение отключено/)).toContainText('источник');
  await expect(page.getByTestId('comparison-delta')).toHaveCount(0);
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue('0');
  await runB(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await expect(page.getByText(/Сравнение отключено/)).toBeVisible();
  await expect(page.getByTestId('comparison-delta')).toHaveCount(0);
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await expect(page.getByLabel('Геометрия сценария')).toHaveValue('river');
});

test('playback keeps both concentrations at the same physical time when switching A and B', async ({ page }) => {
  const a = await demo(page); await variant(page);
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('50');
  const b = await runB(page);
  await page.getByLabel('Расчётный сегмент').selectOption('50');
  await page.getByLabel('Время от начала сценария').fill('24');
  const scale = await page.getByTestId('concentration-scale').innerText();
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Время от начала сценария').inputValue())).toBeGreaterThan(25);
  await page.getByRole('button', { name: 'Показать А', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const time = Number(await page.getByLabel('Время от начала сценария').inputValue());
  const lower = Math.floor(time), fraction = time - lower;
  const interpolate = (data: typeof a) => data.concentrations_mg_l[lower][50] + fraction * (data.concentrations_mg_l[lower + 1][50] - data.concentrations_mg_l[lower][50]);
  await expect(page.getByTestId('comparison-a')).toHaveText(numberText(interpolate(a)));
  await expect(page.getByTestId('comparison-b')).toHaveText(numberText(interpolate(b)));
  await expect(page.getByTestId('selected-concentration')).toHaveText(numberText(interpolate(a)));
  await expect(page.getByTestId('concentration-scale')).toHaveText(scale, { useInnerText: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Показать А', exact: true })).toHaveCount(0);
  await expect(page.locator('.simulation-segment')).toHaveCount(0);
});

test('all six physical parameters belong to B and A changes only through explicit replacement', async ({ page }) => {
  const a = await demo(page); await variant(page);
  const parameters = [
    ['Расход реки Qr, м³/с', '20'], ['Расход стоков q, м³/с', '0.2'],
    ['Фоновая концентрация cb, мг/л', '5'], ['Концентрация стоков ce, мг/л', '50'],
    ['Скорость течения u, м/с', '0.3'], ['Продольная дисперсия D, м²/с', '10'],
  ];
  for (const [label, value] of parameters) await page.getByLabel(label, { exact: true }).fill(value);
  const b = await runB(page);
  expect(b.inputs).toMatchObject({ river_flow_m3_s: 20, effluent_flow_m3_s: .2, background_mg_l: 5, effluent_mg_l: 50, velocity_m_s: .3, dispersion_m2_s: 10 });
  await page.getByLabel('Время от начала сценария').fill('24');
  await expect(page.getByTestId('comparison-a')).toHaveText(numberText(a.concentrations_mg_l[24][0]));
  await expect(page.getByTestId('comparison-b')).toHaveText(numberText(b.concentrations_mg_l[24][0]));
  await expect(page.getByTestId('concentration-scale')).toContainText('5,0000');
  await expect(page.getByTestId('concentration-scale')).toContainText('10,8911');
  await page.getByRole('button', { name: 'Заменить А показанным расчётом', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  for (const [label, value] of parameters) await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
  await runB(page);
  await page.getByLabel('Время от начала сценария').fill('24');
  await expect(page.getByTestId('comparison-a')).toHaveText(numberText(b.concentrations_mg_l[24][0]));
  await expect(page.getByTestId('comparison-delta')).toHaveText('0,0000 мг/л');
});

test('mobile comparison preserves status, focus and time controls with both panels', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await demo(page);
  await page.getByRole('button', { name: 'Параметры', exact: true }).click();
  await variant(page);
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('50');
  await runB(page);
  await page.getByLabel('Время от начала сценария').fill('24');
  await page.getByRole('button', { name: 'Профиль и показатели', exact: true }).click();
  await expect(page.locator('.simulation-profile polyline')).toHaveCount(2);
  await page.getByRole('button', { name: 'Показать А', exact: true }).click();
  await expect(page.getByLabel('Время от начала сценария')).toHaveValue('24');
  await page.getByRole('button', { name: 'Параметры', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Закрыть параметры' })).toBeFocused();
  await expect(page.locator('#model-profile')).toHaveAttribute('inert', '');
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('25');
  await page.getByRole('button', { name: 'Закрыть параметры' }).click();
  await expect(page.getByRole('button', { name: 'Параметры', exact: true })).toBeFocused();
  await expect(page.locator('.simulation-stale')).toContainText('Б');
  expect(await page.locator('.simulation-stale').evaluate(element => {
    const b = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
  })).toBeTruthy();
  await expect(page.getByLabel('Время от начала сценария')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('explains incompatible geometry returned by the server instead of silently enabling comparison', async ({ page }) => {
  const a = await demo(page); await variant(page);
  const changed = structuredClone(a);
  changed.geometry.coordinates[1][0] += .0001;
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: changed }));
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  await expect(page.getByText(/Сравнение отключено/)).toContainText('геометрия');
  await expect(page.getByTestId('comparison-delta')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Результат расчёта', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await expect(page.getByText(/Сравнение отключено/)).toHaveCount(0);
});
