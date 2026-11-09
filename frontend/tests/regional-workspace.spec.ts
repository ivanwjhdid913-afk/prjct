import { expect, test } from '@playwright/test';
import { multipleResultFixture } from './multiple-result-fixture';

test('regional overview is reachable from the model and returns without changing the form', async ({ page }) => {
  await page.goto('/#model');
  await expect(page.getByRole('heading', { name: 'Несколько сценарных источников' })).toBeVisible();
  const open = page.getByRole('button', { name: 'Обзор области', exact: true });
  await expect(open).toBeVisible({ timeout: 3000 });
  const source = page.getByLabel('Название источника', { exact: true });
  await source.fill('Проверка черновика');
  await open.click();
  await expect(page.getByTestId('regional-overview')).toBeVisible();
  await expect(source).toBeHidden();
  await page.getByRole('button', { name: 'К моделированию', exact: true }).click();
  await expect(source).toHaveValue('Проверка черновика');
  await expect(open).toBeFocused();
});

test('an in-flight calculation completes while the overview remains open', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.goto('/#model');
  const registry = await (await page.request.get('/api/v1/river-reaches')).json();
  const reach = registry.items.find((item: { id: string }) => item.id === 'don-olkhovets');
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const sent = page.waitForRequest(request => request.url().endsWith('/simulations'));
  await page.route('**/api/v1/simulations', async route => {
    await pending;
    await route.fulfill({ json: multipleResultFixture(route.request().postDataJSON(), reach) });
  });
  try {
    await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    await sent;
    await page.getByRole('button', { name: 'Обзор области', exact: true }).click();
    await expect(page.getByTestId('regional-overview')).toBeVisible();
    await expect(page.getByRole('button', { name: 'К моделированию', exact: true })).toBeVisible();
    finish();
    await page.getByRole('button', { name: 'Вернуться к результату', exact: true }).click();
    await expect(page.locator('.simulation-segment')).toHaveCount(100);
  } finally {
    finish();
  }
});
