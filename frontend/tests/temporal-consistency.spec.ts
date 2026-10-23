import { expect, test, type Page } from '@playwright/test';
import { concentrationsAt, openParameters, openProfile } from './model-helpers';

const geometry = { type: 'LineString', coordinates: [[39.2, 52.5], [39.201, 52.502], [39.203, 52.501]] };
const sample = (times: number[], values: number[]) => ({
  inputs: { river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10, effluent_mg_l: 100, velocity_m_s: 1, dispersion_m2_s: 5, length_m: 500, duration_hours: 1, load_mode: 'finite', load_duration_hours: 5 / 3600 },
  derived: { total_flow_m3_s: 10.1, area_m2: 10.1, load_kg_s: .01, excess_load_kg_s: .009, steady_mg_l: 10.89, travel_hours: 500 / 3600 },
  distances_m: [125, 375], times_hours: times, concentrations_mg_l: values.map(value => [value, value]),
  scale_mg_l: [Math.min(...values), Math.max(...values)], geometry,
});
type Series = ReturnType<typeof sample>;
const formatted = (value: number) => value.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const table = (page: Page) => page.getByRole('table', { name: 'Концентрация сегмента во времени' });

async function setup(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.goto('/#model');
  await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длина участка L, м').fill('500');
  await page.getByLabel('Длительность, ч').fill('1');
  await page.getByLabel('Скорость течения u, м/с').fill('1');
}

async function compare(page: Page, a: Series, b: Series) {
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: a }));
  await setup(page);
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.locator('.simulation-segment')).toHaveCount(a.distances_m.length);
  await openParameters(page);
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await page.route('**/api/v1/simulations', route => route.fulfill({ json: b }));
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Показать А', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Показать А', exact: true }).click();
  await openTimeTable(page);
}

async function openTimeTable(page: Page) {
  await openProfile(page);
  await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await expect(page.locator('.temporal-profile tbody tr')).toHaveCount(0);
  await page.getByText('Таблица C(t)', { exact: true }).click();
}

test('comparison table preserves both extrema on the exact union independently of active scenario', async ({ page }) => {
  const a = sample([0, 5 / 3600, .1, 1], [10, 12, 10, 10]);
  const b = sample([0, 5 / 3600 + 1e-12, .02, 1], [10, 8, 10, 10]);
  await compare(page, a, b);
  const times = [...new Set([...a.times_hours, ...b.times_hours])].sort((x, y) => x - y);
  const rows = table(page).locator('tbody tr');
  await expect(rows).toHaveCount(times.length);
  for (let index = 0; index < times.length; index++) {
    const cells = rows.nth(index).locator('td');
    await expect(cells.nth(1)).toHaveText(formatted(concentrationsAt(a, times[index])[0]));
    await expect(cells.nth(2)).toHaveText(formatted(concentrationsAt(b, times[index])[0]));
  }
  expect(await rows.nth(1).locator('td').first().innerText()).not.toEqual(await rows.nth(2).locator('td').first().innerText());
  const initial = await rows.allTextContents();
  await page.getByRole('button', { name: 'Показать Б', exact: true }).click();
  await expect(rows).toHaveText(initial);
  await page.getByRole('button', { name: 'Перейти к минимуму', exact: true }).click();
  await expect(page.getByTestId('temporal-cursor')).toHaveAttribute('data-hour', String(b.times_hours[1]));
  await expect(rows).toHaveText(initial);
});

test('maximum comparison union is fully reachable in bounded pages on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const at = [0, ...Array.from({ length: 2046 }, (_, i) => (2 * i + 1) / 4093), 1];
  const bt = [0, ...Array.from({ length: 2046 }, (_, i) => (2 * i + 2) / 4093), 1];
  await compare(page, sample(at, at.map(() => 10)), sample(bt, bt.map(() => 11)));
  await expect(page.getByTestId('temporal-table-status')).toContainText('4094');
  const rows = table(page).locator('tbody tr');
  const initialHour = await page.getByLabel('Время от начала сценария').inputValue();
  const seen: string[] = [];
  for (let index = 0; index < 41; index++) {
    await expect(rows).toHaveCount(index === 40 ? 94 : 100);
    seen.push(...await rows.locator('.temporal-table-hour').allTextContents());
    if (index < 40) {
      const next = page.getByRole('button', { name: 'Следующая страница C(t)', exact: true });
      await next.focus(); await page.keyboard.press('Enter');
    }
  }
  expect(new Set(seen).size).toBe(4094);
  expect(seen.map(time => Number(time.replace(',', '.')))).toEqual([...new Set([...at, ...bt])].sort((a, b) => a - b));
  await expect(page.getByLabel('Время от начала сценария')).toHaveValue(initialHour);
  await expect(page.getByRole('button', { name: 'Следующая страница C(t)', exact: true })).toBeDisabled();
  const lastPage = await rows.allTextContents();
  await page.getByRole('button', { name: 'Показать Б', exact: true }).click();
  await expect(rows).toHaveText(lastPage);
  await expect(page.getByTestId('temporal-table-status')).toContainText('41 / 41');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const bounds = await table(page).boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(375);
  const previous = page.getByRole('button', { name: 'Предыдущая страница C(t)', exact: true });
  await previous.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('temporal-table-status')).toContainText('40 / 41');
  const precedingPage = await rows.allTextContents();
  await page.getByText('Таблица C(t)', { exact: true }).click();
  await expect(page.locator('.temporal-profile tbody tr')).toHaveCount(0);
  await page.getByText('Таблица C(t)', { exact: true }).click();
  await expect(rows).toHaveText(precedingPage);
});

test('real five-second B peak remains in the table while continuous zero-load A is active', async ({ page }) => {
  await setup(page);
  await page.getByLabel('Расход стоков q, м³/с').fill('0');
  const aResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/simulations'));
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  const ar = await aResponse; expect(ar.ok()).toBeTruthy(); const a: Series = await ar.json();
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await page.getByLabel('Расход стоков q, м³/с').fill('0.1');
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
  await page.getByLabel('Период загрязнения, ч', { exact: true }).fill(String(5 / 3600));
  const bResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/simulations'));
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  const br = await bResponse; expect(br.ok()).toBeTruthy(); const b: Series = await br.json();
  await page.getByRole('button', { name: 'Показать А', exact: true }).click();
  await openTimeTable(page);
  const maximum = Math.max(...b.concentrations_mg_l.map(row => row[0]));
  const peakTime = b.times_hours[b.concentrations_mg_l.findIndex(row => row[0] === maximum)];
  expect(peakTime * 3600).toBeCloseTo(5, 9);
  expect(a.times_hours).not.toContain(peakTime);
  const union = [...new Set([...a.times_hours, ...b.times_hours])].sort((x, y) => x - y);
  const expectedPage = Math.floor(union.indexOf(peakTime) / 100);
  for (let i = 0; i < expectedPage; i++) await page.getByRole('button', { name: 'Следующая страница C(t)', exact: true }).click();
  const peakRow = table(page).locator('tbody tr').nth(union.indexOf(peakTime) % 100);
  await expect(peakRow.locator('td').nth(1)).toHaveText('10,0000');
  await expect(peakRow.locator('td').nth(2)).toHaveText(formatted(maximum));
  const initial = await table(page).locator('tbody tr').allTextContents();
  await page.getByRole('button', { name: 'Показать Б', exact: true }).click();
  await expect(table(page).locator('tbody tr')).toHaveText(initial);
});
