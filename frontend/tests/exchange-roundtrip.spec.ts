import { expect, test } from '@playwright/test';
import { openParameters } from './model-helpers';

test.use({ baseURL: process.env.EXCHANGE_UI_URL ?? 'http://127.0.0.1:5173' });
for (const geometry of ['don-olkhovets', 'voronezh-zheltye-peski', 'synthetic']) for (const load of ['continuous', 'finite']) {
  test(`JSON real API roundtrip without writes or calculations: ${geometry}/${load}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    let calculations = 0, writes = 0;
    page.on('request', request => { if (request.url().endsWith('/simulations')) calculations++; if (request.url().endsWith('/scenarios') && request.method() === 'POST') writes++; });
    await page.goto('/#model'); await openParameters(page);
    if (geometry === 'synthetic') {
      await page.getByLabel('Геометрия сценария').selectOption('synthetic');
      await page.getByLabel('Длина участка L, м').fill('500.125');
    } else {
      await page.getByLabel('Подготовленный участок').selectOption(geometry);
      const maximum = await page.getByLabel('Положение сценарного источника, м').getAttribute('max');
      await page.getByLabel('Положение сценарного источника, м').fill(maximum!);
    }
    await page.getByLabel('Длительность, ч').fill('.2');
    await page.getByLabel('Расход стоков q, м³/с').fill('.125');
    await page.getByLabel('Режим нагрузки', { exact: true }).selectOption(load);
    if (load === 'finite') await page.getByLabel('Период загрязнения, ч').fill('.001');
    await page.locator('.saved-scenarios summary').click();
    const name = `${geometry} · ${load}`;
    await page.getByLabel('Название сохраняемых условий').fill(name);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Выгрузить текущие условия JSON', exact: true }).click();
    const download = await pending; const stream = await download.createReadStream();
    const parts: Buffer[] = []; for await (const part of stream!) parts.push(Buffer.from(part));
    const bytes = Buffer.concat(parts), exported = JSON.parse(bytes.toString('utf8'));
    expect(exported.name).toBe(name);
    expect(exported.conditions.duration_hours).toBe(.2);
    expect(exported.conditions.effluent_flow_m3_s).toBe(.125);
    expect(exported.conditions.load_mode).toBe(load);
    if (geometry === 'synthetic') expect(exported.conditions.length_m).toBe(500.125);
    else { expect(exported.geometry_sha256).toMatch(/^[0-9a-f]{64}$/); expect(exported.downstream_geometry_sha256).toMatch(/^[0-9a-f]{64}$/); }
    expect(exported).not.toHaveProperty('concentrations_mg_l');
    await page.reload(); await openParameters(page); await page.locator('.saved-scenarios summary').click();
    const validation = page.waitForResponse(response => response.url().endsWith('/scenario-files/validate'));
    await page.getByLabel('Импортировать условия JSON').setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/json', buffer: bytes });
    expect((await validation).status()).toBe(200);
    await expect(page.getByTestId('conditions-preview')).toContainText('Совместимо');
    await page.getByRole('button', { name: 'Применить к форме', exact: true }).click();
    await expect(page.getByLabel('Геометрия сценария')).toHaveValue(geometry === 'synthetic' ? 'synthetic' : 'river');
    if (geometry !== 'synthetic') {
      await expect(page.getByLabel('Подготовленный участок')).toHaveValue(geometry);
      await expect(page.getByLabel('Положение сценарного источника, м')).toHaveValue(String(exported.conditions.source_distance_m));
    } else await expect(page.getByLabel('Длина участка L, м')).toHaveValue('500.125');
    await expect(page.getByLabel('Длительность, ч')).toHaveValue('0.2');
    await expect(page.getByLabel('Расход стоков q, м³/с')).toHaveValue('0.125');
    await expect(page.getByLabel('Режим нагрузки', { exact: true })).toHaveValue(load);
    expect(calculations).toBe(0); expect(writes).toBe(0);
  });
}
