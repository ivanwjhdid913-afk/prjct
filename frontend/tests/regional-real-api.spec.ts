import { expect, test, type Download, type Page } from '@playwright/test';

const api = process.env.SCENARIO_TEST_API;
const reachId = 'voronezh-below-kuzminka';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });
const sourcePosition = (page: Page) => field(page, 'Положение выбранного источника, м от начала участка');
const clock = (page: Page) => field(page, 'Время от начала сценария');

test.skip(!api || !/^water_test_[0-9a-f]{32}$/.test(process.env.SCENARIO_TEST_DB ?? ''), 'Requires disposable API/database.');
test.use({ video: 'on' });

async function showParameters(page: Page) {
  const toggle = button(page, 'Параметры');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

async function chooseRiver(page: Page, name: string, id: string) {
  const search = page.getByTestId('regional-search');
  await search.fill(name);
  await search.press('Tab');
  await page.keyboard.press('Enter');
  const card = page.getByTestId('regional-object-card');
  await expect(card).toContainText(name);
  await expect(card).toContainText('OpenStreetMap');
  await card.getByLabel('Подготовленный участок', { exact: true }).selectOption(id);
  return card;
}

async function calculate(page: Page) {
  await showParameters(page);
  const response = page.waitForResponse(r => r.url().endsWith('/simulations') && r.request().method() === 'POST');
  await button(page, 'Рассчитать').click();
  const completed = await response;
  expect(completed.status(), await completed.text()).toBe(200);
  const result = await completed.json();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  expect(result.reach_id).toBe(reachId);
  expect(result.inputs.length_m).toBeCloseTo(1274.035, 3);
  expect(result.source_coordinates.map((source: { source_distance_m: number }) => source.source_distance_m)).toEqual([0, 600]);
  expect(Math.abs(result.diagnostics.mass_error_kg)).toBeLessThan(1e-8);
  return result;
}

async function downloadText(promise: Promise<Download>) {
  const parts: Buffer[] = [];
  for await (const part of await (await promise).createReadStream()) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}

for (const width of [1280, 375]) {
  test(`regional overview and actual Kuzminka model at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 667 });
    if (width === 375) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: api + url.pathname + url.search }) });
    });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let loads = 0;
    page.on('request', request => { if (request.url().endsWith('/regional-overview')) loads++; });
    await page.goto('/#model');
    await expect(page.locator('.simulation-preview-segment')).toHaveCount(100);
    const overviewResponse = page.waitForResponse(r => r.url().endsWith('/regional-overview'));
    const start = performance.now();
    await button(page, 'Обзор области').click();
    const response = await overviewResponse;
    const map = page.getByTestId('regional-map');
    await expect(map.locator('[data-regional-feature="lipetsk-oblast"]')).toBeVisible();
    await expect(map.locator('[data-regional-reach]')).toHaveCount(3);
    const openingMs = Math.round(performance.now() - start);
    expect(response.status()).toBe(200);
    const bytes = (await response.body()).byteLength;
    expect(bytes).toBe(484913);
    expect(response.headers().etag).toMatch(/^"[a-f0-9]{64}"$/);
    await expect(page.getByTestId('regional-load-status')).toContainText('Подложка недоступна');
    if (width === 375) {
      const overview = page.getByTestId('regional-overview');
      await overview.evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
      const unobstructed = await button(page, 'К моделированию').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
      });
      expect(unobstructed).toBe(true);
      await overview.evaluate(panel => { panel.scrollTop = 0; });
    }
    await page.screenshot({ path: info.outputPath(`overview-${width}.png`) });
    const search = page.getByTestId('regional-search');
    await search.fill('Богородицкое');
    await search.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('regional-object-card')).toContainText('одномерный речной решатель');
    await expect(button(page, 'К выбранному участку')).toHaveCount(0);
    const card = await chooseRiver(page, 'Воронеж', reachId);
    await expect(page.locator('#multiple-reach')).toHaveValue('don-olkhovets');
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`passport-${width}.png`) });
    await button(page, 'К выбранному участку').click();
    await showParameters(page);
    await expect(page.locator('#multiple-reach')).toHaveValue(reachId);
    await expect(sourcePosition(page)).toBeEmpty();
    await sourcePosition(page).fill('0');
    await field(page, 'Длительность, ч').fill('1.5');
    await field(page, 'Режим нагрузки выбранного источника').selectOption('finite');
    await field(page, 'Период нагрузки выбранного источника, ч').fill('.1');
    await button(page, 'Добавить источник').click();
    await sourcePosition(page).fill('600');
    await field(page, 'Расход стоков выбранного источника q, м³/с').fill('.05');
    await field(page, 'Концентрация стоков выбранного источника ce, мг/л').fill('60');
    const a = await calculate(page);
    await expect(page.locator('.multiple-map-source')).toHaveCount(2);
    await button(page, 'Воспроизвести').click();
    await expect.poll(async () => Number(await clock(page).inputValue())).toBeGreaterThan(.03);
    await button(page, 'Пауза').click();
    await clock(page).fill('0.6');
    const analysis = page.locator('.multiple-stage-top').getByRole('button', { name: 'Контрольные точки', exact: true });
    await analysis.click();
    await field(page, 'Сегмент для контрольной точки').selectOption('49');
    await button(page, 'Закрепить выбранный сегмент').click();
    await field(page, 'Пользовательский порог, мг/л').fill('10.2');
    await button(page, 'Применить настройки анализа').click();
    await expect(page.locator('.multiple-map-control-point')).toHaveCount(1);
    await showParameters(page);
    await button(page, 'Закрепить как А').click();
    await button(page, 'Создать вариант Б').click();
    await field(page, 'Выбрать источник 2').click();
    await field(page, 'Концентрация стоков выбранного источника ce, мг/л').fill('30');
    const b = await calculate(page);
    expect(a.inputs.sources[1].effluent_mg_l).toBe(60);
    expect(b.inputs.sources[1].effluent_mg_l).toBe(30);
    await clock(page).fill('0.6');
    await button(page, 'Показать А').click();
    await button(page, 'Во времени C(t)').click();
    const mapPane = page.locator('.multiple-map .leaflet-map-pane');
    await mapPane.evaluate(element => { (element as HTMLElement).dataset.testIdentity = 'same'; });
    await expect(page.getByTestId('temporal-a')).toBeAttached();
    await expect(page.getByTestId('temporal-b')).toBeAttached();
    await expect(page.getByTestId('temporal-current')).toBeVisible();
    if (width === 1280) {
      const size = await page.locator('.multiple-map-area').boundingBox();
      await button(page, 'Параметры').click();
      expect((await page.locator('.multiple-map-area').boundingBox())!.width).toBeGreaterThan(size!.width + 200);
      await expect(page.getByTestId('temporal-current')).toBeInViewport();
      await expect(page.getByTestId('temporal-extremum')).toBeInViewport();
      await expect(page.locator('.temporal-profile svg')).toBeInViewport();
    } else {
      await expect.poll(() => page.evaluate(() => {
        const mapBounds = document.querySelector('.multiple-map-area')!.getBoundingClientRect();
        const profileTop = document.querySelector('.multiple-profile')!.getBoundingClientRect().top;
        const river = document.querySelector('.multiple-river-centerline')?.getBoundingClientRect();
        const visibleSegments = [...document.querySelectorAll('.simulation-segment')].filter(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.height + bounds.width > 0 && bounds.top >= mapBounds.top && bounds.bottom <= profileTop;
        });
        return {
          fullRiverAboveProfile: !!river && river.height > 20 && river.top >= mapBounds.top && river.bottom <= profileTop,
          visibleResultStrokes: visibleSegments.length > 10,
        };
      })).toEqual({ fullRiverAboveProfile: true, visibleResultStrokes: true });
    }
    await page.screenshot({ path: info.outputPath(`simulation-${width}.png`) });
    await button(page, 'Обзор области').click();
    await expect(map.locator('[data-regional-reach]')).toHaveCount(3);
    await button(page, 'Вернуться к результату').click();
    await expect(clock(page)).toHaveValue('0.6');
    await expect(button(page, 'Показать А')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.multiple-map-control-point')).toHaveCount(1);
    await expect(mapPane).toHaveAttribute('data-test-identity', 'same');
    expect(loads).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(pageErrors).toEqual([]);
    await info.attach('regional-timing', { body: JSON.stringify({ width, openingMs, bytes, loads }), contentType: 'application/json' });

    if (width === 1280) {
      await page.locator('.result-exports summary').click();
      const csvPromise = page.waitForEvent('download', { timeout: 5000 });
      await button(page, 'Скачать C(t) CSV').click();
      const csv = await downloadText(csvPromise);
      expect(csv).toContain(reachId);
      expect(csv).toContain(b.reach_metadata.geometry_sha256);
      await showParameters(page);
      await page.locator('.saved-scenarios summary').click();
      const name = `Кузьминка ${Date.now()}`;
      await page.getByLabel('Название сохраняемых условий').fill(name);
      const saved = page.waitForResponse(r => r.url().endsWith('/scenarios') && r.request().method() === 'POST');
      await button(page, 'Сохранить как новый сценарий').click();
      const savedResponse = await saved;
      expect(savedResponse.status(), await savedResponse.text()).toBe(201);
      const jsonPromise = page.waitForEvent('download', { timeout: 5000 });
      await button(page, 'Выгрузить текущие условия JSON').click();
      const json = await downloadText(jsonPromise);
      expect(json).toContain(reachId);
      expect(json).toContain(b.reach_metadata.downstream_geometry_sha256);
      await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: 'kuzminka.json', mimeType: 'application/json', buffer: Buffer.from(json) });
      await button(page, 'Применить к форме').click();
      await expect(sourcePosition(page)).toHaveValue('0');
      await page.reload();
      await showParameters(page);
      await page.locator('.saved-scenarios summary').click();
      await button(page, `Открыть «${name}»`).click();
      await expect(page.locator('#multiple-reach')).toHaveValue(reachId);
      const reopened = await calculate(page);
      expect(reopened.inputs).toEqual(b.inputs);
      await analysis.click();
      await expect(field(page, 'Пользовательский порог, мг/л')).toHaveValue('10.2');
      await button(page, 'Обзор области').click();
      await chooseRiver(page, 'Дон', 'don-olkhovets');
      await button(page, 'К выбранному участку').click();
      await expect(sourcePosition(page)).toBeEmpty();
      await expect(page.locator('.multiple-map-control-point')).toHaveCount(0);
      await expect(page.locator('.control-points-panel')).toContainText('другой геометрии');
      await button(page, 'Обзор области').click();
      await button(page, 'Вернуться к результату').click();
      await expect(page.locator('.simulation-segment')).toHaveCount(100);
      await expect(page.locator('.multiple-map-control-point')).toHaveCount(1);
      await expect(sourcePosition(page)).toBeEmpty();
      await sourcePosition(page).fill('12');
      await button(page, 'Показать завершённый расчёт').click();
      await button(page, 'Обзор области').click();
      await chooseRiver(page, 'Дон', 'don-olkhovets');
      await button(page, 'К выбранному участку').click();
      await expect(page.locator('.multiple-stage-top')).toContainText('черновик положений');
      await expect(sourcePosition(page)).toHaveValue('12');
    }
  });
}

test('legacy overview retains A/B and never displays an unassigned source on a new reach', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: api + url.pathname + url.search }) });
  });
  await page.goto('/#model/legacy');
  await button(page, 'Запустить демонстрацию').click();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  await button(page, 'Закрепить как А').click();
  await button(page, 'Создать вариант Б').click();
  await field(page, 'Концентрация стоков ce, мг/л').fill('50');
  await button(page, 'Рассчитать Б').click();
  await button(page, 'Показать А').click();
  await clock(page).fill('0.6');
  await button(page, 'Обзор области').click();
  await chooseRiver(page, 'Воронеж', reachId);
  await button(page, 'К выбранному участку').click();
  const position = field(page, 'Положение сценарного источника, м');
  await expect(position).toBeEmpty();
  const unassignedMarkers = await page.locator('.reach-preview .scenario-source-marker').count();
  await button(page, 'Обзор области').click();
  await button(page, 'Вернуться к результату').click();
  await expect(button(page, 'Показать А')).toHaveAttribute('aria-pressed', 'true');
  await expect(clock(page)).toHaveValue('0.6');
  expect(unassignedMarkers).toBe(0);
});

test('a legacy result finished behind the overview fits the visible map on return', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: api + url.pathname + url.search }) });
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/#model/legacy');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/simulations', async route => {
    const response = await route.fetch({ url: `${api}/api/v1/simulations` });
    await pending;
    await route.fulfill({ response });
  });
  try {
    await button(page, 'Запустить демонстрацию').click();
    await button(page, 'Обзор области').click();
    await expect(page.getByTestId('regional-overview')).toBeVisible();
    release();
    await button(page, 'Вернуться к результату').click();
    await expect.poll(() => page.evaluate(() => {
      const map = document.querySelector('.simulation-map')?.getBoundingClientRect();
      if (!map) return 0;
      return [...document.querySelectorAll('.simulation-segment')].filter(element => {
        const path = element.getBoundingClientRect();
        return path.width + path.height > 0 && path.left >= map.left && path.right <= map.right && path.top >= map.top && path.bottom <= map.bottom;
      }).length;
    })).toBeGreaterThanOrEqual(90);
  } finally {
    release();
  }
});
