import { expect, test } from '@playwright/test';

test('regional overview opens the network without replacing the legacy draft', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/river-networks/pilot', route => route.fulfill({ status: 503, json: { detail: 'Тестовый отказ загрузки сети' } }));
  await page.goto('/#model/legacy');
  const source = page.getByLabel('Положение сценарного источника, м', { exact: true });
  await source.fill('123');
  await page.getByRole('button', { name: 'Обзор области', exact: true }).click();
  await page.getByRole('button', { name: 'Сеть Воронеж — Кузьминка', exact: true }).click();
  await expect(page).toHaveURL(/#model\/network$/);
  await expect(page.getByRole('heading', { name: 'Речная сеть', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'К обзору области', exact: true }).click();
  await expect(page.getByTestId('regional-overview')).toBeVisible();
  await page.getByRole('button', { name: 'К моделированию', exact: true }).click();
  await expect(source).toHaveValue('123');
});

test('direct network URL enters the model and browser Back restores the overview', async ({ page }) => {
  await page.goto('/#model');
  await page.getByRole('button', { name: 'Обзор области', exact: true }).click();
  await page.getByRole('button', { name: 'Сеть Воронеж — Кузьминка', exact: true }).click();
  await expect(page).toHaveURL(/#model\/network$/);
  await page.goBack();
  await expect(page.getByTestId('regional-overview')).toBeVisible();
});
