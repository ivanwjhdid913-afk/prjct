import { expect, test, type Page } from '@playwright/test';
import { concentrationsAt, openParameters, openProfile } from './model-helpers';

const text = (v: number) => `${v.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`;
async function finiteDemo(page: Page) {
  await page.goto('/#model'); await openParameters(page);
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations'));
  await page.getByRole('button', { name: 'Демонстрация периода', exact: true }).click();
  const r = await response; expect(r.ok()).toBeTruthy();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  return r.json();
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route('https://tile.openstreetmap.org/**', r => r.abort());
});

test('finite demo shows exact load end, transport and return to background', async ({ page }) => {
  const r = await finiteDemo(page);
  expect(r.inputs.load_mode).toBe('finite'); expect(r.inputs.load_duration_hours).toBe(.5);
  expect(r.inputs.duration_hours).toBe(6);
  await expect(page.getByTestId('source-status')).toContainText('Повышенная нагрузка действует');
  await expect(page.getByTestId('load-end-marker')).toHaveAttribute('data-hour', '0.5');
  await page.getByLabel('Время от начала сценария').fill('0.5');
  await expect(page.getByTestId('source-status')).toContainText('Повышенная нагрузка завершена');
  await page.getByLabel('Время от начала сценария').fill('2');
  const row = concentrationsAt(r, 2);
  expect(row[0]).toBeLessThan(10.001); expect(Math.max(...row)).toBeGreaterThan(10.2);
  expect(row.indexOf(Math.max(...row))).toBeGreaterThan(20);
  await expect(page.getByTestId('selected-concentration')).toHaveText(text(row[0]));
  await page.getByLabel('Время от начала сценария').fill('6');
  expect(Math.max(...concentrationsAt(r, 6))).toBeLessThan(10.001);
});

test('C(t) follows selected map segment and shares physical cursor and current concentration', async ({ page }) => {
  const r = await finiteDemo(page);
  await page.getByLabel('Время от начала сценария').fill('1.5625');
  await openProfile(page);
  await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await page.getByLabel('Сегмент для графика времени').selectOption('50');
  const expected = concentrationsAt(r, 1.5625)[50];
  await expect(page.getByTestId('temporal-current')).toHaveText(text(expected));
  await expect(page.getByTestId('temporal-cursor')).toHaveAttribute('data-hour', '1.5625');
  const initial = await page.getByTestId('temporal-curve').getAttribute('points');
  // Adjacent short segments have overlapping stroke caps. Verify the segment
  // actually hit by the pointer, rather than assuming the underlying SVG path.
  const clickedIndex = await page.locator('.simulation-segment').nth(25).evaluate(element => {
    const box = element.getBoundingClientRect();
    return [...document.querySelectorAll('.simulation-segment')].indexOf(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)!);
  });
  expect(clickedIndex).toBeGreaterThanOrEqual(0); expect(clickedIndex).not.toBe(50);
  await page.locator('.simulation-segment').nth(25).click({ force: true });
  await expect(page.getByLabel('Сегмент для графика времени')).toHaveValue(String(clickedIndex));
  expect(await page.getByTestId('temporal-curve').getAttribute('points')).not.toBe(initial);
  await expect(page.locator('.simulation-segment').nth(clickedIndex)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('temporal-current')).toHaveText(text(concentrationsAt(r, 1.5625)[clickedIndex]));
  await page.getByRole('button', { name: 'По расстоянию C(x)', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Профиль концентрации по расстоянию' })).toBeVisible();
});

test('constant A and finite B keep independent settings, scale and time', async ({ page }) => {
  await page.goto('/#model'); await page.getByRole('button', { name: 'Запустить демонстрацию', exact: true }).click();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
  await page.getByLabel('Период загрязнения, ч', { exact: true }).fill('0.5317');
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations'));
  await page.getByRole('button', { name: 'Рассчитать Б', exact: true }).click();
  const r = await (await response).json(); expect(r.inputs.load_duration_hours).toBe(.5317);
  await page.getByLabel('Время от начала сценария').fill('2');
  const scale = await page.getByTestId('concentration-scale').innerText();
  await openProfile(page); await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await expect(page.getByTestId('temporal-a')).toBeVisible(); await expect(page.getByTestId('temporal-b')).toBeVisible();
  await page.getByRole('button', { name: 'Показать А', exact: true }).click();
  await expect(page.getByTestId('source-status')).toContainText('А: Повышенная нагрузка действует');
  await expect(page.getByTestId('source-status')).toContainText('Б: Повышенная нагрузка завершена');
  await expect(page.getByLabel('Время от начала сценария')).toHaveValue('2');
  await expect(page.getByTestId('concentration-scale')).toHaveText(scale, { useInnerText: true });
  await page.getByRole('button', { name: 'Закрыть профиль' }).click();
  await page.getByLabel('Период загрязнения, ч', { exact: true }).fill('1');
  await expect(page.locator('.simulation-stale')).toBeVisible();
  await expect(page.getByTestId('load-end-marker')).toHaveAttribute('data-hour', '0.5317');
  await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
  await expect(page.getByLabel('Режим нагрузки', { exact: true })).toHaveValue('continuous');
});

for (const height of [667, 812]) test(`finite timeline and temporal profile remain accessible on a 375x${height} phone`, async ({ page }) => {
  await page.setViewportSize({ width: 375, height }); await finiteDemo(page);
  await expect(page.getByTestId('source-status')).toBeInViewport();
  await expect(page.getByLabel('Время от начала сценария')).toBeInViewport();
  await openProfile(page); await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
  await page.getByLabel('Сегмент для графика времени').selectOption('50');
  await page.getByLabel('Время от начала сценария').fill('2');
  await expect(page.getByTestId('temporal-cursor')).toHaveAttribute('data-hour', '2');
  await openParameters(page); await expect(page.getByRole('button', { name: 'Закрыть параметры' })).toBeFocused();
  await page.getByLabel('Период загрязнения, ч', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Закрыть параметры' }).click();
  await expect(page.locator('.simulation-stale')).toBeInViewport();
  await expect(page.getByTestId('source-status')).toContainText('завершена');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
