import { expect, test, type Page } from '@playwright/test';
import { concentrationsAt, openParameters, openProfile } from './model-helpers';

const geometry = { type: 'LineString', coordinates: [[39.2, 52.5], [39.201, 52.502], [39.203, 52.501]] };
const reach = { id: 'time-test', name: 'Проверочный участок', length_m: 1000, geometry, distances_m: [0, 500, 1000], metadata: {} };
const sample = (negative = false) => ({
  inputs: { river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10, effluent_mg_l: negative ? 0 : 100, velocity_m_s: .25, dispersion_m2_s: 5, length_m: 1000, duration_hours: 4, load_mode: 'finite', load_duration_hours: 5 / 3600 },
  derived: { total_flow_m3_s: 10.1, area_m2: 40.4, load_kg_s: .01, excess_load_kg_s: negative ? -.001 : .009, steady_mg_l: negative ? 9 : 12, travel_hours: 1 },
  distances_m: [250, 750], times_hours: [0, 5 / 3600, .02, .1, 4],
  concentrations_mg_l: [[10, 10], [negative ? 8 : 12, 10], [10, negative ? 9 : 11], [10, 10], [10, 10]],
  scale_mg_l: negative ? [8, 10] : [10, 12], geometry,
});

async function mock(page: Page, result: unknown) {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/river-reaches', route => route.fulfill({ json: { items: [reach] } }));
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: result }));
  await page.goto('/#model');
  await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длина участка L, м').fill('1000');
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
  await page.getByLabel('Период загрязнения, ч', { exact: true }).fill(String(5 / 3600));
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
}

test('nonuniform grid uses physical hours and preserves a five-second peak', async ({ page }) => {
  await mock(page, sample());
  const slider = page.getByLabel('Время от начала сценария');
  await expect(slider).toHaveAttribute('max', '4');
  await slider.fill('0.01');
  await openProfile(page);
  await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await expect(page.getByTestId('temporal-cursor')).toHaveAttribute('data-hour', '0.01');
  await page.getByRole('button', { name: 'Перейти к максимуму', exact: true }).click();
  await expect(page.getByTestId('temporal-cursor')).toHaveAttribute('data-hour', String(5 / 3600));
  await expect(page.getByTestId('temporal-current')).toHaveText('12,0000 мг/л');
  await expect(page.getByTestId('temporal-extremum')).toContainText('Расчётная оценка');
  await expect(page.getByTestId('source-status')).toContainText('завершена');
  await expect(slider).toHaveAttribute('aria-valuetext', '5,000 с');
  await expect(page.locator('output[for="simulation-time"]')).toHaveText('5,000 с');
  await expect(page.getByTestId('temporal-resolution')).toContainText('не указана');
});

test('independent A and B grids share physical time, map geometry, scale and active extrema', async ({ page }) => {
  const a = sample();
  const b = { ...sample(true), times_hours: [0, .05, 1, 4], concentrations_mg_l: [[10, 10], [8, 9], [10, 10], [10, 10]] };
  await mock(page, a);
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: b }));
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  const slider = page.getByLabel('Время от начала сценария');
  await slider.fill('0.01');
  const scale = await page.getByTestId('concentration-scale').innerText();
  await page.getByRole('button', { name: 'Увеличить масштаб', exact: true }).click();
  const shape = await page.locator('.simulation-segment').first().getAttribute('d');
  const view = await page.locator('.simulation-map .leaflet-map-pane').getAttribute('style');
  await expect(page.getByTestId('comparison-a')).toHaveText(`${concentrationsAt(a, .01)[0].toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`);
  await expect(page.getByTestId('comparison-b')).toHaveText('9,6000 мг/л');
  await openProfile(page); await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await page.getByRole('button', { name: 'Перейти к минимуму', exact: true }).click();
  await expect(slider).toHaveValue('0.05');
  await page.getByRole('button', { name: 'Показать А', exact: true }).click();
  await expect(slider).toHaveValue('0.05');
  await expect(page.getByRole('button', { name: 'Перейти к максимуму', exact: true })).toBeVisible();
  await expect(page.getByTestId('concentration-scale')).toHaveText(scale, { useInnerText: true });
  await expect(page.locator('.simulation-segment').first()).toHaveAttribute('d', shape!);
  await expect(page.locator('.simulation-map .leaflet-map-pane')).toHaveAttribute('style', view!);
  await page.getByRole('button', { name: 'Перейти к максимуму', exact: true }).click();
  await expect(page.getByTestId('temporal-cursor')).toHaveAttribute('data-hour', String(5 / 3600));
});

test('accepts 2048 states, explains flat series and validates row counts', async ({ page }) => {
  const times = Array.from({ length: 2048 }, (_, i) => 4 * i / 2047);
  const data = { ...sample(), times_hours: times, concentrations_mg_l: times.map(() => [10, 10]) };
  await mock(page, data);
  await expect(page.locator('.simulation-segment')).toHaveCount(2);
  await openProfile(page); await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await expect(page.getByTestId('temporal-extremum')).toContainText('Отклонения от фона нет');
  await expect(page.getByRole('button', { name: 'Перейти к максимуму', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрыть профиль' }).click();
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: { ...data, concentrations_mg_l: [[10, 10]] } }));
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер вернул неполные результаты');
});

test('resolution metadata explains the numerical reference and rejects exceeded tolerance', async ({ page }) => {
  const metadata = { method: 'adaptive-step-states', saved_states: 5, reference_states: 1000, max_states: 2048, interpolation_relative_tolerance: .01, interpolation_absolute_tolerance_mg_l: 1e-9, max_relative_interpolation_error: .009, reference_max_step_seconds: 1, max_gap_seconds: 14040, memory_limit_bytes: 16777216, reference_memory_bytes: 808000, max_response_bytes: 5242880 };
  await mock(page, { ...sample(), temporal_resolution: metadata });
  await openProfile(page);
  await expect(page.getByTestId('temporal-resolution')).toContainText('Сохранено 5 моментов из 1000');
  await expect(page.getByTestId('temporal-resolution')).toContainText('1,00% амплитуды');
  await expect(page.getByTestId('temporal-resolution')).toContainText('а не точности физической модели');
  await page.getByRole('button', { name: 'Закрыть профиль' }).click();
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: { ...sample(), temporal_resolution: { ...metadata, max_relative_interpolation_error: .02 } } }));
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер вернул неполные результаты');
});

test('real five-second finite load exposes the preserved near-source peak and downstream transport', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.goto('/#model'); await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длина участка L, м').fill('500');
  await page.getByLabel('Длительность, ч').fill('1');
  await page.getByLabel('Скорость течения u, м/с').fill('1');
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
  await page.getByLabel('Период загрязнения, ч', { exact: true }).fill(String(5 / 3600));
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations'));
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  const r = await response; expect(r.ok()).toBeTruthy(); const data = await r.json();
  expect(data.times_hours.length).toBeGreaterThan(49);
  expect(data.temporal_resolution.max_relative_interpolation_error).toBeLessThanOrEqual(.01);
  await openProfile(page); await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await page.getByRole('button', { name: 'Перейти к максимуму', exact: true }).click();
  const firstTime = Number(await page.getByLabel('Время от начала сценария').inputValue());
  expect(firstTime * 3600).toBeGreaterThan(4); expect(firstTime * 3600).toBeCloseTo(5, 9);
  expect(Math.max(...data.concentrations_mg_l.map((row: number[]) => row[0]))).toBeGreaterThan(10.4);
  await page.getByLabel('Сегмент для графика времени').selectOption('49');
  await page.getByRole('button', { name: 'Перейти к максимуму', exact: true }).click();
  const downstreamTime = Number(await page.getByLabel('Время от начала сценария').inputValue());
  expect(downstreamTime * 3600).toBeGreaterThan(200);
  await expect(page.getByTestId('source-status')).toContainText('завершена');
  await expect(page.getByTestId('temporal-current')).toHaveText(`${Math.max(...data.concentrations_mg_l.map((row: number[]) => row[49])).toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`);
});

test('playback advances linearly in physical time across an uneven grid', async ({ page }) => {
  await mock(page, sample());
  await page.clock.install();
  const slider = page.getByLabel('Время от начала сценария');
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await page.clock.runFor(6000);
  expect(Number(await slider.inputValue())).toBeCloseTo(1, 1);
  await page.clock.runFor(6000);
  expect(Number(await slider.inputValue())).toBeCloseTo(2, 1);
  await page.getByLabel('Скорость воспроизведения').selectOption('2');
  await page.clock.runFor(6000);
  await expect(slider).toHaveValue('4');
  await expect(page.getByRole('button', { name: 'Воспроизвести', exact: true })).toBeVisible();
});

for (const [name, times] of Object.entries({ duplicate: [0, .1, .1, 4], decreasing: [0, 2, 1, 4], nonfinite: [0, NaN, 4], start: [.1, 4], endpoint: [0, 1, 3], oversized: Array.from({ length: 2049 }, (_, i) => 4 * i / 2048) })) {
  test(`rejects ${name} timestamps`, async ({ page }) => {
    await mock(page, { ...sample(), times_hours: times, concentrations_mg_l: times.map(() => [10, 10]) });
    await expect(page.getByRole('alert')).toContainText('Сервер вернул неполные результаты');
    await expect(page.locator('.simulation-segment')).toHaveCount(0);
  });
}

for (const height of [667, 812]) test(`minimum jump and keyboard time remain accessible at 375x${height}`, async ({ page }) => {
  await page.setViewportSize({ width: 375, height });
  await mock(page, sample(true));
  await openProfile(page);
  await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  const jump = page.getByRole('button', { name: 'Перейти к минимуму', exact: true });
  await jump.focus(); await page.keyboard.press('Enter');
  await expect(jump).toBeFocused();
  await expect(page.getByTestId('temporal-current')).toHaveText('8,0000 мг/л');
  const slider = page.getByLabel('Время от начала сценария');
  await expect(slider).toBeInViewport();
  await slider.press('End'); await expect(slider).toHaveValue('4');
  await slider.press('Home'); await expect(slider).toHaveValue('0');
  await slider.press('ArrowRight'); expect(Number(await slider.inputValue())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Закрыть профиль' }).click();
  await expect(page.getByRole('button', { name: 'Профиль и показатели', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
