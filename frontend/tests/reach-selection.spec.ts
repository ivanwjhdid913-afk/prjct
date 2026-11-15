import { expect, test } from '@playwright/test';
import { openParameters } from './model-helpers';

const reach = 'voronezh-below-kuzminka';

for (const model of ['multiple', 'legacy'] as const) {
  for (const entry of ['list', 'overview'] as const) {
    test(`${model}: ${entry} requires new source positions and keeps the completed result`, async ({ page }) => {
      await page.route('https://tile.openstreetmap.org/**', route => route.abort());
      await page.goto(model === 'legacy' ? '/#model/legacy' : '/#model');
      await openParameters(page);
      const position = page.locator(model === 'legacy' ? '#source-distance' : '#multiple-source-distance');
      const selection = page.locator(model === 'legacy' ? '#reach-id' : '#multiple-reach');
      const calculate = page.getByRole('button', { name: 'Рассчитать', exact: true });
      await expect(selection).toHaveValue('don-olkhovets');
      await position.fill('100');
      await calculate.click();
      await expect(page.locator('.simulation-segment')).toHaveCount(100);
      if (entry === 'list') await selection.selectOption(reach);
      else {
        await page.getByRole('button', { name: 'Обзор области', exact: true }).click();
        await page.getByTestId('regional-search').fill('Воронеж');
        await page.getByRole('button', { name: /Воронеж · Река/ }).click();
        await page.getByTestId('regional-object-card').getByRole('combobox').selectOption(reach);
        await page.getByRole('button', { name: 'К выбранному участку', exact: true }).click();
      }
      await expect(selection).toHaveValue(reach);
      await expect(position).toBeEmpty();
      await expect(calculate).toBeDisabled();
      await expect(page.locator('.reach-preview .scenario-source-marker, .multiple-map-source')).toHaveCount(0);
      await page.getByRole('button', { name: /Показать (завершённый расчёт|рассчитанный результат)/ }).click();
      await expect(page.locator('.simulation-segment')).toHaveCount(100);
      await expect(position).toBeEmpty();
      await position.fill('100');
      await expect(calculate).toBeEnabled();
    });
  }
}

test('legacy narrow workspace skips the clipped current-mode control in Tab order', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/#model/legacy');
  const section = page.getByRole('link', { name: 'Исходные данные', exact: true });
  await section.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Несколько источников', exact: true })).toBeFocused();
});
