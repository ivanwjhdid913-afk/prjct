import { expect, test, type Page } from '@playwright/test';
import { openProfile } from './model-helpers';

async function expectSourceAndSelectionExposed(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const host = document.querySelector('.simulation-map')!;
    const map = host.getBoundingClientRect();
    const profile = document.querySelector('#model-profile')!.getBoundingClientRect();
    const source = host.querySelector('.scenario-source-marker')!.getBoundingClientRect();
    const segment = host.querySelector<SVGPathElement>('.simulation-segment[data-selected="true"]')!;
    const point = segment.getPointAtLength(segment.getTotalLength() / 2).matrixTransform(segment.getScreenCTM()!);
    const clear = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('.simulation-map') === host;
    const separateRegions = innerWidth <= 1100 ? profile.top >= map.bottom - 1 : profile.left >= map.right - 1;
    return separateRegions && map.height >= 130 && map.width >= 300
      && source.left >= map.left && source.right <= map.right && source.top >= map.top && source.bottom <= map.bottom
      && point.x > map.left + 5 && point.x < map.right - 5 && point.y > map.top + 5 && point.y < map.bottom - 5
      && clear(source.x + source.width / 2, source.y + source.height / 2) && clear(point.x, point.y);
  })).toBeTruthy();
}

for (const viewport of [{ width: 375, height: 667 }, { width: 375, height: 812 }, { width: 768, height: 720 }, { width: 1024, height: 768 }, { width: 1280, height: 720 }]) {
  test(`profile preserves exposed source, last segment, time and map instance at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    await page.goto('/#model');
    await page.getByRole('button', { name: 'Запустить демонстрацию', exact: true }).click();
    await expect(page.locator('.simulation-segment')).toHaveCount(100);
    await page.getByLabel('Расчётный сегмент', { exact: true }).selectOption('99');
    await page.locator('.simulation-map').evaluate(element => element.setAttribute('data-profile-regression-instance', 'original'));
    await openProfile(page);
    await expect(page.getByRole('button', { name: 'Закрыть профиль' })).toBeFocused();
    await expectSourceAndSelectionExposed(page);
    await page.getByRole('button', { name: 'Во времени C(t)', exact: true }).click();
    const curve = await page.getByTestId('temporal-curve').getAttribute('points');
    const hit = await page.locator('.simulation-segment').nth(49).evaluate(element => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
      return { x: point.x, y: point.y, index: [...document.querySelectorAll('.simulation-segment')].indexOf(document.elementFromPoint(point.x, point.y)!) };
    });
    expect(hit.index).toBeGreaterThanOrEqual(0);
    expect(hit.index).not.toBe(99);
    await page.mouse.click(hit.x, hit.y);
    await expect(page.getByLabel('Сегмент для графика времени')).toHaveValue(String(hit.index));
    expect(await page.getByTestId('temporal-curve').getAttribute('points')).not.toBe(curve);
    await expectSourceAndSelectionExposed(page);
    await page.getByLabel('Сегмент для графика времени').selectOption('0');
    await expectSourceAndSelectionExposed(page);
    if (viewport.width === 375) {
      await page.getByTestId('temporal-extremum').evaluate(element => {
        element.scrollIntoView({ block: 'start' });
        const panel = element.closest('#model-profile')!;
        panel.scrollTop -= panel.querySelector('.profile-drawer-heading')!.getBoundingClientRect().height + 8;
      });
      const panel = (await page.locator('#model-profile').boundingBox())!;
      for (const item of [page.getByTestId('temporal-extremum'), page.locator('.temporal-profile svg')]) {
        const box = (await item.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(panel.y);
        expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height);
      }
      const close = page.getByRole('button', { name: 'Закрыть профиль' });
      await expect(close).toBeInViewport();
      expect(await close.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBeTruthy();
      await expect(page.getByTestId('concentration-scale')).toBeInViewport();
      await expect(page.locator('.profile-drawer-heading .simulation-gradient')).toBeInViewport();
      await expectSourceAndSelectionExposed(page);
    }
    await page.getByLabel('Сегмент для графика времени').selectOption('99');
    await expectSourceAndSelectionExposed(page);
    const map = page.locator('.simulation-map');
    await expect(map).toHaveAttribute('data-profile-regression-instance', 'original');
    const pane = page.locator('.simulation-map .leaflet-map-pane');
    const transform = await pane.getAttribute('style');
    const path = await page.locator('.simulation-segment').last().getAttribute('d');
    await page.getByLabel('Время от начала сценария').fill('1.2345');
    await expect(page.getByTestId('temporal-cursor')).toHaveAttribute('data-hour', '1.2345');
    await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
    await expect.poll(async () => Number(await page.getByLabel('Время от начала сценария').inputValue())).toBeGreaterThan(1.24);
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expectSourceAndSelectionExposed(page);
    expect(await pane.getAttribute('style')).toBe(transform);
    expect(await page.locator('.simulation-segment').last().getAttribute('d')).toBe(path);
    await expect(page.getByLabel('Время от начала сценария')).toBeInViewport();
    if (viewport.width === 375) await page.getByTestId('temporal-extremum').evaluate(element => {
      element.scrollIntoView({ block: 'start' });
      const panel = element.closest('#model-profile')!;
      panel.scrollTop -= panel.querySelector('.profile-drawer-heading')!.getBoundingClientRect().height + 8;
    });
    await page.screenshot({ path: `.cache/lipetsk-map/profile-map-${viewport.width}-${viewport.height}.png` });
    await page.getByRole('button', { name: 'Закрыть профиль' }).click();
    await expect(page.getByRole('button', { name: 'Профиль и показатели', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}
