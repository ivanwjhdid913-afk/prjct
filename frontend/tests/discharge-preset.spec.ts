import { expect, test } from '@playwright/test';

test('the CSOK passport explains the missing coordinates and the different flow and chloride periods', async ({ page }, info) => {
  await page.goto('/#discharge-data');
  const card = page.locator('#discharge-rvk-lipetsk-cosk');
  await card.locator(':scope > summary').click();
  const passport = card.getByRole('region', { name: 'Паспорт выпуска ЦОСК' });
  await expect(passport).toBeVisible();
  await expect(passport).toContainText('Август 2022');
  await expect(passport).toContainText('122 мг/дм³');
  await expect(passport).toContainText('109 мг/дм³');
  await expect(passport).toContainText('112,7 тыс. м³/сут');
  await expect(passport).toContainText('поступление на технологическую линию');
  await expect(passport).toContainText('Координаты выпуска для расчёта не подтверждены');
  await expect(passport.getByRole('button', { name: 'Применить условия' })).toBeDisabled();
  if (process.env.DISCHARGE_PASSPORT_MEDIA === '1') await passport.screenshot({ path: info.outputPath('cosk-blocked.png') });
});

test('the synthetic passport rejects changed prepared geometry and leaves conditions unapplied', async ({ page }, info) => {
  await page.route('**/api/v1/river-reaches', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.items.find((item: { id: string }) => item.id === 'don-olkhovets').metadata.geometry_sha256 = 'f'.repeat(64);
    await route.fulfill({ response, json: data });
  });
  await page.goto('/#discharge-data');
  await page.getByText('Условный источник на Дону', { exact: true }).click();
  const passport = page.getByRole('region', { name: 'Условный источник на Дону' });
  await expect(passport.getByRole('status')).toContainText('Геометрия подготовленного участка изменилась');
  await expect(passport.getByRole('button', { name: 'Применить условия' })).toBeDisabled();
  await expect(page).toHaveURL(/#discharge-data$/);
  if (process.env.DISCHARGE_PASSPORT_MEDIA === '1') await passport.screenshot({ path: info.outputPath('geometry-blocked.png') });
});
