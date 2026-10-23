import { expect, test } from '@playwright/test';
import { concentrationsAt, openParameters, openProfile } from './model-helpers';

for (const geometry of ['river', 'synthetic']) for (const duration of [.1, .2, .4, .7, 6.1]) {
  test(`actual API accepts ${duration} hours in ${geometry}, continuous and finite A/B`, async ({ page }) => {
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    await page.goto('/#model'); await openParameters(page);
    await page.getByLabel('Геометрия сценария').selectOption(geometry);
    if (geometry === 'synthetic') await page.getByLabel('Длина участка L, м').fill('1000');
    await page.getByLabel('Длительность, ч', { exact: true }).fill(String(duration));
    async function calculate(name: string) {
      const pending = page.waitForResponse(r => r.url().endsWith('/api/v1/simulations'));
      await page.getByRole('button', { name, exact: true }).click();
      const response = await pending; expect(response.ok()).toBeTruthy();
      const result = await response.json();
      expect(result.times_hours[0]).toBe(0);
      expect(result.times_hours.at(-1)).toBe(duration);
      expect(result.times_hours.every((t: number, i: number, times: number[]) => Number.isFinite(t) && t >= 0 && t <= duration && (!i || t > times[i - 1]))).toBeTruthy();
      expect(result.concentrations_mg_l.length).toBe(result.times_hours.length);
      await expect(page.locator('.simulation-segment')).toHaveCount(100);
      return result;
    }
    const a = await calculate('Рассчитать');
    await expect(page.getByLabel('Время от начала сценария')).toHaveAttribute('max', String(duration));
    await page.getByRole('button', { name: 'Закрепить как А', exact: true }).click();
    await page.getByRole('button', { name: 'Создать вариант Б', exact: true }).click();
    await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
    const end = duration / 3;
    await page.getByLabel('Период загрязнения, ч', { exact: true }).fill(String(end));
    const b = await calculate('Рассчитать Б');
    expect(b.times_hours).toContain(end);
    await expect(page.getByRole('button', { name: 'Показать Б', exact: true })).toBeEnabled();
    const hour = duration / 2;
    await page.getByLabel('Время от начала сценария').fill(String(hour));
    for (const [id, result] of [['comparison-a', a], ['comparison-b', b]] as const) {
      await expect(page.getByTestId(id)).toHaveText(`${concentrationsAt(result, hour)[0].toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`);
    }
    for (const name of ['Показать А', 'Показать Б']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByLabel('Время от начала сценария')).toHaveValue(String(hour));
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('finite pulse distinguishes numerical accuracy from saved trajectory accuracy', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.goto('/#model'); await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  await page.getByLabel('Длина участка L, м').fill('1000');
  await page.getByLabel('Длительность, ч', { exact: true }).fill('1');
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
  await page.getByLabel('Период загрязнения, ч', { exact: true }).fill('0.001');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await openProfile(page);
  await expect(page.getByTestId('numerical-accuracy')).toContainText('качественной иллюстрации');
  await expect(page.getByTestId('numerical-accuracy')).toContainText('пространственного и временного шагов');
  await expect(page.getByTestId('numerical-accuracy')).toContainText('исходных данных');
});
