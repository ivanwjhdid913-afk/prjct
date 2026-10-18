import { expect, test, type Locator } from '@playwright/test';

async function expectUncovered(locator: Locator) {
  await expect(locator).toBeInViewport();
  await expect.poll(() => locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.goto('/#model');
});

test('mobile parameters receive focus and shield preview, result and profile controls', async ({ page }) => {
  await expect(page.locator('.scenario-source-marker')).toBeVisible();
  const open = page.getByRole('button', { name: 'Параметры', exact: true });
  await open.click();
  await expect(page.getByRole('button', { name: 'Закрыть параметры' })).toBeFocused();
  await expect(page.locator('.reach-preview')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Закрыть параметры' }).click();
  await expect(open).toBeFocused();
  await page.getByRole('button', { name: 'Запустить демонстрацию' }).click();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  await page.getByRole('button', { name: 'Профиль и показатели', exact: true }).click();
  await open.click();
  await expect(page.getByRole('button', { name: 'Закрыть параметры' })).toBeFocused();
  await expect(page.locator('#model-profile')).toHaveAttribute('inert', '');
  await expect(page.locator('.map-panel')).toHaveAttribute('inert', '');
  await expect(page.locator('.map-inspector')).toHaveAttribute('inert', '');
  await page.getByLabel('Время от начала сценария').focus();
  await expect(page.getByLabel('Время от начала сценария')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  for (let step = 0; step < 22; step++) {
    expect(await page.evaluate(() => !!document.activeElement?.closest('.map-panel, .map-inspector, #model-profile'))).toBeFalsy();
    await page.keyboard.press('Tab');
  }
  await page.getByRole('button', { name: 'Закрыть параметры' }).click();
  await expect(open).toBeFocused();
  await expect(page.locator('#model-profile')).not.toHaveAttribute('inert', '');
});

test('changed conditions stay uncovered with both mobile panels and after parameters close', async ({ page }) => {
  await page.getByRole('button', { name: 'Запустить демонстрацию' }).click();
  await page.getByRole('button', { name: 'Профиль и показатели', exact: true }).click();
  await page.getByRole('button', { name: 'Параметры', exact: true }).click();
  await page.getByLabel('Концентрация стоков ce, мг/л').fill('50');
  await expectUncovered(page.locator('.simulation-stale'));
  await page.getByRole('button', { name: 'Закрыть параметры' }).click();
  await expectUncovered(page.locator('.simulation-stale'));
  await expect(page.getByRole('button', { name: 'Закрыть профиль' })).toBeVisible();
});

test('loading and calculation errors remain uncovered with mobile overlays', async ({ page }) => {
  await page.getByRole('button', { name: 'Запустить демонстрацию' }).click();
  await page.getByRole('button', { name: 'Профиль и показатели', exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/simulations', async route => {
    await held;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.getByRole('button', { name: 'Параметры', exact: true }).click();
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expectUncovered(page.locator('.calculation-status'));
  await page.getByRole('button', { name: 'Параметры', exact: true }).click();
  await expectUncovered(page.locator('.calculation-status'));
  release();
  await expectUncovered(page.getByRole('alert'));
  await page.getByRole('button', { name: 'Закрыть параметры' }).click();
  await expectUncovered(page.getByRole('alert'));
  await expect(page.getByLabel('Время от начала сценария')).toBeInViewport();
});
