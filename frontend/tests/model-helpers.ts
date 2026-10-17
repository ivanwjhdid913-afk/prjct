import { type Page } from '@playwright/test';

export async function openParameters(page: Page) {
  const toggle = page.getByRole('button', { name: 'Параметры', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

export async function openProfile(page: Page) {
  const toggle = page.getByRole('button', { name: 'Профиль и показатели', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}
