import { type Page } from '@playwright/test';

// Independent test oracle: locate the bracketing physical timestamps.
export function concentrationsAt(result: { times_hours: number[]; concentrations_mg_l: number[][] }, hour: number) {
  const next = result.times_hours.findIndex(time => time >= hour);
  if (next === 0) return result.concentrations_mg_l[0];
  if (next < 0) return result.concentrations_mg_l.at(-1)!;
  const fraction = (hour - result.times_hours[next - 1]) / (result.times_hours[next] - result.times_hours[next - 1]);
  return result.concentrations_mg_l[next - 1].map((value, index) => value + fraction * (result.concentrations_mg_l[next][index] - value));
}

export async function openParameters(page: Page) {
  const toggle = page.getByRole('button', { name: 'Параметры', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

export async function openProfile(page: Page) {
  const toggle = page.getByRole('button', { name: 'Профиль и показатели', exact: true });
  if (!await page.locator('#model-profile').isVisible()) await toggle.click();
}
