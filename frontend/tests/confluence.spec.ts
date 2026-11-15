import { expect, test, type Page } from '@playwright/test';
import { resultCsv, toDraft, toInputs, type Inputs, type Result } from '../src/confluenceData';

const geometry = {
  id: 'synthetic-confluence-v1', junction_m: [1000, 250], branches: [
    { id: 'a', length_m: 1000, coordinates_m: [[200, 850], [1000, 250]] },
    { id: 'b', length_m: 500, coordinates_m: [[700, -150], [1000, 250]] },
    { id: 'out', length_m: 900, coordinates_m: [[1000, 250], [1200, 250], [1200, 450], [1700, 450]] },
  ],
};
const defaults = {
  background_mg_l: .2, duration_hours: 2.5,
  branches: [
    { id: 'a', flow_m3_s: 3, velocity_m_s: .5, dispersion_m2_s: 1, concentration_mg_l: 5, load_duration_minutes: 30 },
    { id: 'b', flow_m3_s: 1, velocity_m_s: .3, dispersion_m2_s: 1, concentration_mg_l: 3, load_duration_minutes: null },
  ],
  downstream: { velocity_m_s: .4, dispersion_m2_s: 2 },
};
const balance = { input: [0, 4, 8], output: [0, 1, 3], stored: [0, 3, 5], residual: [0, 0, 0] };
const result = {
  model_id: 'conservative-1d-confluence-v1', format_version: 1, geometry, inputs: defaults,
  flows_m3_s: { a: 3, b: 1, out: 4 }, times_hours: [0, 1, 2.5],
  concentrations_mg_l: { a: [[.2, .2], [2, 1], [3, 1.5]], b: [[.2, .2], [.9, .8], [2, 1.5]], out: [[.2, .2], [.95, .3], [1.5, .8]] },
  junction_mg_l: { a: [.2, 1, 1.5], b: [.2, .8, 1.5], out: [.2, .95, 1.5] }, scale_mg_l: [0, 5],
  balance_kg: balance, branch_balance_kg: { a: balance, b: balance, out: balance },
  grid: { cells: { a: 2, b: 2, out: 2 }, max_step_seconds: 5 },
};

test('an inlet pulse can end exactly at the fractional horizon', () => {
  const inputs = { ...defaults, duration_hours: .12,
    branches: defaults.branches.map(branch => ({ ...branch, load_duration_minutes: branch.id === 'a' ? 7.2 : null })) } as Inputs;
  expect(toInputs(toDraft(inputs))).toEqual(inputs);
});

test('CSV records each branch balance once per saved time', async () => {
  const csv = resultCsv(result as Result);
  expect(csv).toBeInstanceOf(Blob);
  const [header, ...rows] = (await csv.text()).trimEnd().split('\r\n').map(row => row.split(','));
  expect(rows.every(row => row.length === header.length)).toBe(true);
  const balanceRows = rows.filter(row => row[0] === 'balance' && Number(row[1]) === 2.5);
  expect(balanceRows.map(row => row[2])).toEqual(['a', 'b', 'out', 'network']);
  expect(Number(balanceRows[3][header.indexOf('input_delta_from_background_kg')])).toBe(8);
  const metadata = rows.find(row => row[0] === 'metadata')!;
  expect(metadata[header.indexOf('csv_schema_version')]).toBe('2');
  expect(metadata[header.indexOf('background_mg_l')]).toBe('0.2');
  expect(metadata[header.indexOf('balance_reference')]).toBe('relative_to_background');
});

test('CSV preserves a signed deficit against the saved background', async () => {
  const deficit = { input: [0, -72, -72], output: [0, 0, -72], stored: [0, -72, 0], residual: [0, 0, 0] };
  const inputs = { ...defaults, background_mg_l: 10, branches: [
    { ...defaults.branches[0], flow_m3_s: 8, load_duration_minutes: 15, concentration_mg_l: 0 },
    { ...defaults.branches[1], flow_m3_s: 2, concentration_mg_l: 10 },
  ] };
  const csv = resultCsv({ ...result, inputs, times_hours: [0, .25, 2.5],
    flows_m3_s: { a: 8, b: 2, out: 10 }, balance_kg: deficit } as Result);
  const [header, ...rows] = (await csv.text()).trimEnd().split('\r\n').map(row => row.split(','));
  expect(rows[0][header.indexOf('background_mg_l')]).toBe('10');
  const network = rows.filter(row => row[0] === 'balance' && row[2] === 'network');
  expect(network.map(row => Number(row[header.indexOf('input_delta_from_background_kg')]))).toEqual([0, -72, -72]);
  expect(Number(network[1][header.indexOf('stored_delta_from_background_kg')])).toBe(-72);
  expect(Number(network[2][header.indexOf('output_delta_from_background_kg')])).toBe(-72);
});

async function openPilot(page: Page) {
  await page.route('**/api/v1/confluence/pilot', route => route.fulfill({ json: { geometry, defaults } }));
  await page.route('**/api/v1/confluence/simulations', route => {
    const inputs = route.request().postDataJSON() as typeof defaults;
    return route.fulfill({ json: { ...result, inputs, flows_m3_s: { a: inputs.branches[0].flow_m3_s, b: inputs.branches[1].flow_m3_s, out: inputs.branches.reduce((sum, branch) => sum + branch.flow_m3_s, 0) } } });
  });
  await page.goto('/#model/confluence');
  await expect(page.getByTestId('confluence-map')).toBeVisible();
  await page.getByRole('button', { name: 'Рассчитать слияние', exact: true }).click();
  await expect(page.getByTestId('confluence-time')).toBeEnabled();
}

test('pilot shows all branches and the junction on a metric plan with a fixed concentration legend', async ({ page }) => {
  await openPilot(page);
  const map = page.getByTestId('confluence-map');
  for (const branch of ['a', 'b', 'out']) await expect(map.locator(`[data-confluence-branch="${branch}"]`)).toBeVisible();
  await expect(map.locator('.leaflet-tile')).toHaveCount(0);
  await map.getByRole('button', { name: 'Узел слияния', exact: true }).press('Enter');
  await expect(page.getByTestId('confluence-node')).toContainText('4 м³/с');
  const legend = await page.getByTestId('confluence-legend').innerText();
  await page.getByTestId('confluence-time').fill('2');
  await expect(page.getByTestId('confluence-legend')).toHaveText(legend, { useInnerText: true });
  const bentCell = map.locator('[data-confluence-segment="out-1"]');
  expect((await bentCell.getAttribute('d'))?.match(/L/g)).toHaveLength(3);
  await bentCell.dispatchEvent('click');
  await page.getByLabel('Расчётный сегмент ниже узла').selectOption('1');
  await expect(page.getByTestId('confluence-chart')).toContainText('450–900 м');
  await expect(page.getByTestId('confluence-chart')).toContainText('0,8 мг/л');
});

test('mobile reduced motion retains the map, edits mark a result stale, and exports use the accepted inputs', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPilot(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  const map = page.getByTestId('confluence-map');
  const area = await map.boundingBox();
  expect(area).toBeTruthy();
  for (const id of ['a', 'b', 'out']) {
    const box = await map.locator(`[data-confluence-branch="${id}"]`).boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThan(area!.x);
    expect(box!.x + box!.width).toBeLessThan(area!.x + area!.width);
    expect(box!.y).toBeGreaterThan(area!.y);
    expect(box!.y + box!.height).toBeLessThan(area!.y + area!.height);
  }
  const play = page.getByRole('button', { name: 'Воспроизвести расчёт' });
  await expect(play).toBeEnabled();
  await play.click();
  await page.getByRole('button', { name: 'Приостановить расчёт' }).click();
  await page.locator('summary').filter({ hasText: 'Условия расчёта' }).click();
  await page.getByLabel('Расход ветви A').fill('7');
  await expect(page.getByTestId('confluence-stale')).toBeVisible();
  const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать JSON' }).click()]);
  const stream = await json.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8')).inputs.branches[0].flow_m3_s).toBe(3);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать CSV' }).click()]);
  const csvStream = await csv.createReadStream();
  const csvChunks: Buffer[] = [];
  for await (const chunk of csvStream) csvChunks.push(Buffer.from(chunk));
  const csvText = Buffer.concat(csvChunks).toString('utf8');
  expect(csvText.split('\r\n')[0]).toContain('branch_id,segment_id');
  expect(csvText).toContain(',out,out-2,450,900,0.8,');
  await page.getByRole('button', { name: 'Рассчитать слияние', exact: true }).click();
  await expect(page.getByTestId('confluence-stale')).toHaveCount(0);
});

test('a newer accepted run wins, and solver errors preserve the previous accepted result', async ({ page }) => {
  await openPilot(page);
  await page.locator('summary').filter({ hasText: 'Условия расчёта' }).click();
  const flow = page.getByLabel('Расход ветви A');
  const run = page.getByRole('button', { name: 'Рассчитать слияние', exact: true });
  let releaseOlder!: () => void;
  const older = new Promise<void>(resolve => { releaseOlder = resolve; });
  await page.route('**/api/v1/confluence/simulations', async route => {
    const inputs = route.request().postDataJSON() as typeof defaults;
    const a = inputs.branches[0].flow_m3_s;
    if (a === 10) await older;
    if (a === 20) return route.fulfill({ status: 422, json: { detail: 'The requested run would exceed the pilot limit for time steps' } });
    if (a === 30) return route.fulfill({ status: 503, json: { detail: 'The pilot solver is busy' } });
    await route.fulfill({ json: { ...result, inputs, flows_m3_s: { a, b: 1, out: a + 1 } } }).catch(error => { if (a !== 10) throw error; });
  });
  await flow.fill('10');
  const first = page.waitForRequest(request => request.url().endsWith('/api/v1/confluence/simulations') && request.postDataJSON().branches[0].flow_m3_s === 10);
  await run.click();
  await first;
  await flow.fill('15');
  await page.getByRole('button', { name: 'Пересчитать слияние', exact: true }).click();
  await expect(page.getByTestId('confluence-node')).toContainText('16 м³/с');
  releaseOlder();
  await flow.fill('20');
  await run.click();
  await expect(page.getByRole('alert')).toContainText('Уменьшите горизонт расчёта');
  await flow.fill('30');
  await run.click();
  await expect(page.getByRole('alert')).toContainText('Повторите попытку через несколько секунд');
  await expect(page.getByTestId('confluence-node')).toContainText('16 м³/с');
  await expect(page.getByTestId('confluence-stale')).toBeVisible();
});

test('an unresponsive pilot or solver times out and can be retried', async ({ page }) => {
  await page.clock.install();
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const pilotUrl = '**/api/v1/confluence/pilot';
  const solveUrl = '**/api/v1/confluence/simulations';
  await page.route(pilotUrl, async route => { await stalled; await route.abort().catch(() => {}); });
  await page.route(solveUrl, async route => { await stalled; await route.abort().catch(() => {}); });
  try {
    const opening = page.waitForRequest(request => request.url().endsWith('/confluence/pilot'));
    await page.goto('/#model/confluence');
    await opening;
    await page.clock.fastForward(12_100);
    await expect(page.getByRole('alert')).toContainText('Время ожидания');
    await page.route(pilotUrl, route => route.fulfill({ json: { geometry, defaults } }));
    await page.getByRole('button', { name: 'Повторить загрузку' }).click();
    const submitted = page.waitForRequest(request => request.url().endsWith('/confluence/simulations'));
    const run = page.getByRole('button', { name: 'Рассчитать слияние', exact: true });
    await run.click();
    await submitted;
    await page.clock.fastForward(30_100);
    await expect(page.getByRole('alert')).toContainText('Время ожидания');
    await page.route(solveUrl, route => route.fulfill({ json: result }));
    await run.click();
    await expect(page.getByTestId('confluence-time')).toBeEnabled();
  } finally {
    release();
  }
});

test('browser Back restores the active scenario form after opening the pilot', async ({ page }) => {
  await page.route('**/api/v1/confluence/pilot', route => route.fulfill({ json: { geometry, defaults } }));
  await page.goto('/#model/legacy');
  await page.getByRole('button', { name: 'Несколько источников', exact: true }).click();
  const position = page.locator('#multiple-source-distance');
  await position.fill('100');
  await page.getByRole('link', { name: 'Слияние рек', exact: true }).click();
  await expect(page.getByTestId('confluence-map')).toBeVisible();
  await page.goBack();
  await expect(position).toHaveValue('100');
  await expect(position).toBeVisible();
});
