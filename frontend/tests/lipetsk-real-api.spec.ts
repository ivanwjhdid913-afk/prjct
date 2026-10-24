import { expect, test, type Page } from '@playwright/test';
import { concentrationsAt, openParameters, openProfile } from './model-helpers';

const PILOT = 'voronezh-zheltye-peski';
async function riverClick(page: Page, share: number) {
  const point = await page.locator('.reach-preview-line').evaluate((element, fraction) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() * fraction);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  }, share);
  await page.mouse.click(point.x, point.y);
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 667 }]) {
  test(`actual Lipetsk pilot: map source, calculation, physical time and immutable result at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    let calculations = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/simulations')) calculations++; });
    const catalogResponse = await page.request.get('/api/v1/river-reaches');
    expect(catalogResponse.ok()).toBeTruthy();
    const catalog = (await catalogResponse.json()).items;
    const reach = catalog.find((item: { id: string }) => item.id === PILOT);
    expect(reach).toBeTruthy();
    await page.goto('/#model'); await openParameters(page);
    await page.getByLabel('Подготовленный участок', { exact: true }).selectOption(PILOT);
    await expect(page.locator('.reach-preview')).toHaveAttribute('data-reach-id', PILOT);
    await page.getByRole('button', { name: 'Указать источник на карте', exact: true }).click();
    const pendingSnap = page.waitForResponse(response => response.url().includes(`/${PILOT}/source-snap?`));
    await riverClick(page, .25);
    const snapResponse = await pendingSnap; expect(snapResponse.ok()).toBeTruthy();
    const snap = await snapResponse.json();
    expect(snap.reach_id).toBe(PILOT);
    expect(snap.source_distance_m).toBeGreaterThan(0);
    expect(snap.source_distance_m).toBeLessThanOrEqual(reach.length_m - 100);
    expect(snap.distance_to_river_m).toBeLessThan(10);
    await expect(page.locator('.reach-preview')).toHaveAttribute('data-source-coordinate', JSON.stringify(snap.coordinate));
    expect(calculations).toBe(0);
    await openParameters(page);
    await expect(page.getByLabel('Положение сценарного источника, м', { exact: true })).toHaveValue(String(snap.source_distance_m));
    await page.getByLabel('Длительность, ч', { exact: true }).fill('1');
    await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite');
    await page.getByLabel('Период загрязнения, ч', { exact: true }).fill('0.1');
    const pending = page.waitForResponse(response => response.url().endsWith('/api/v1/simulations'));
    await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    const response = await pending; expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.reach_id).toBe(PILOT);
    expect(result.source_distance_m).toBe(snap.source_distance_m);
    for (let i = 0; i < 2; i++) expect(result.source_coordinate[i]).toBeCloseTo(snap.coordinate[i], 9);
    expect(result.diagnostics.relative_excess_mass_error).toBeLessThan(1e-9);
    await expect(page.locator('.simulation-segment')).toHaveCount(100);
    await expect(page.locator('.simulation-map-label')).toHaveText(reach.name);
    await page.getByLabel('Время от начала сценария').fill('0.15');
    const expected = concentrationsAt(result, .15)[0].toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    await expect(page.getByTestId('selected-concentration')).toHaveText(`${expected} мг/л`);
    await openProfile(page);
    await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
    await expect(page.getByTestId('temporal-current')).toHaveText(`${expected} мг/л`);
    await page.getByRole('button', { name: 'Перейти к максимуму', exact: true }).click();
    const peak = Math.max(...result.concentrations_mg_l.map((row: number[]) => row[0]));
    expect(Number(await page.getByLabel('Время от начала сценария').inputValue())).toBe(result.times_hours[result.concentrations_mg_l.findIndex((row: number[]) => row[0] === peak)]);
    await page.getByRole('button', { name: 'Закрыть профиль', exact: true }).click();
    await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
    const initialTime = Number(await page.getByLabel('Время от начала сценария').inputValue());
    await expect.poll(async () => Number(await page.getByLabel('Время от начала сценария').inputValue())).toBeGreaterThan(initialTime + .01);
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await openParameters(page);
    await page.getByLabel('Подготовленный участок', { exact: true }).selectOption('don-olkhovets');
    await expect(page.getByText('Параметры изменены. Результат относится к предыдущим условиям.', { exact: true })).toBeVisible();
    if (viewport.width < 760) await page.getByRole('button', { name: 'Закрыть параметры', exact: true }).click();
    await expect(page.locator('.reach-preview')).toHaveAttribute('data-reach-id', 'don-olkhovets');
    await page.getByRole('button', { name: 'Показать рассчитанный результат', exact: true }).click();
    await expect(page.locator('.simulation-map-label')).toHaveText(reach.name);
    expect(calculations).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}
