import { expect, test, type Page, type Download } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { openParameters, openProfile, concentrationsAt } from './model-helpers';

async function parseCsv(download: Download) {
  const file = await download.path();
  const script = "import csv,json,sys; f=open(sys.argv[1],encoding='utf-8-sig',newline=''); print(json.dumps(list(csv.DictReader(f)),ensure_ascii=True))";
  return JSON.parse(execFileSync('python', ['-c', script, file!], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as Record<string, string>[];
}
async function exportFile(page: Page, label: string) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: label, exact: true }).click(); return pending;
}
async function exportPanel(page: Page) {
  await openProfile(page);
  const panel = page.locator('#model-profile .result-exports');
  if (await panel.getAttribute('open') === null) await panel.locator('summary').click();
}
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 720 }); await page.route('https://tile.openstreetmap.org/**', route => route.abort()); });

test('CSV is disabled without a completed result and explains why', async ({ page }) => {
  await page.goto('/#model');
  await expect(page.getByText('Выгрузка CSV доступна после завершения расчёта.', { exact: true })).toBeVisible();
});

test('actual five-second history exports every saved time and peak; changed form cannot change result metadata', async ({ page }) => {
  await page.goto('/#model'); await openParameters(page);
  await page.getByLabel('Геометрия сценария').selectOption('synthetic');
  for (const [label,value] of [['Длина участка L, м','500'],['Длительность, ч','1'],['Скорость течения u, м/с','1']] as const) await page.getByLabel(label).fill(value);
  await page.getByLabel('Режим нагрузки', { exact: true }).selectOption('finite'); await page.getByLabel('Период загрязнения, ч').fill(String(5 / 3600));
  const response = page.waitForResponse(r => r.url().endsWith('/simulations'));
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click(); const result = await (await response).json();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  await openParameters(page); await page.getByLabel('Концентрация стоков ce, мг/л').fill('25');
  if (await page.getByRole('button', {name:'Закрыть параметры'}).isVisible()) await page.getByRole('button', {name:'Закрыть параметры'}).click();
  await page.getByLabel('Время от начала сценария').fill('0.001');
  await exportPanel(page);
  const ct = await parseCsv(await exportFile(page,'Скачать C(t) CSV'));
  const rows = ct.filter(row => row.record_type === 'data');
  expect(rows.map(row => Number(row.time_hours))).toEqual(result.times_hours);
  expect(rows.map(row => Number(row.concentration_mg_l))).toEqual(result.concentrations_mg_l.map((row:number[]) => row[0]));
  expect(Math.max(...rows.map(row => Number(row.concentration_mg_l)))).toBeGreaterThan(10.49);
  const meta = JSON.parse(ct.find(row => row.record_type === 'metadata')!.metadata_json);
  expect(meta.scenarios[0].inputs.effluent_mg_l).toBe(100);
  expect(meta.scenarios[0].model_id).toBe('conservative-1d-advection-dispersion-v1');
  const cx = await parseCsv(await exportFile(page,'Скачать C(x) CSV'));
  expect(cx.filter(row => row.record_type === 'data').map(row => Number(row.concentration_mg_l))).toEqual(concentrationsAt(result,.001));
  expect(cx.filter(row => row.record_type === 'data').map(row => Number(row.distance_from_source_m))).toEqual(result.distances_m);
  expect(cx.filter(row => row.record_type === 'data').every(row => row.method === 'linear_interpolation')).toBeTruthy();
});

test('comparison exports full union independent of active result and pagination, with escaped metadata', async ({ page }) => {
  const base = { inputs:{river_flow_m3_s:10,effluent_flow_m3_s:0,background_mg_l:10,effluent_mg_l:100,velocity_m_s:1,dispersion_m2_s:5,length_m:500,duration_hours:1,load_mode:'continuous',load_duration_hours:null},derived:{total_flow_m3_s:10,area_m2:10,load_kg_s:0,excess_load_kg_s:0,steady_mg_l:10,travel_hours:1},distances_m:[125,375],times_hours:[0,.5,1],concentrations_mg_l:[[10,10],[10,10],[10,10]],scale_mg_l:[10,10],geometry:{type:'LineString',coordinates:[[39,52],[39.001,52.001],[39.002,52.002]]}, model_id:'conservative-1d-advection-dispersion-v1', format_version:1 };
  base.times_hours = [0,...Array.from({length:2046},(_,i)=>(2*i+1)/4093),1];
  base.concentrations_mg_l = base.times_hours.map(()=>[10,10]);
  const metadataName = 'Синтетика, "проверка"\n=не формула';
  const primary = { ...base, reach_metadata: { name: metadataName, source: 'Test source', attribution: '© источник, "проверка"', license: 'ODbL-1.0', source_url: 'https://source.example/geometry' } };
  const times = [0,...Array.from({length:2046},(_,i)=>(2*i+2)/4093),1];
  const b = {...base,inputs:{...base.inputs,effluent_flow_m3_s:.1,load_mode:'finite',load_duration_hours:5/3600},times_hours:times,concentrations_mg_l:times.map((_,i)=>[i===1?10.505969:10,i===100?10.2:10]),scale_mg_l:[10,10.505969]};
  await page.route('**/api/v1/simulations',route=>route.fulfill({json:primary}));
  await page.goto('/#model'); await openParameters(page); await page.getByLabel('Геометрия сценария').selectOption('synthetic'); await page.getByLabel('Длина участка L, м').fill('500'); await page.getByLabel('Длительность, ч').fill('1');
  await page.getByRole('button',{name:'Рассчитать',exact:true}).click(); await expect(page.locator('.simulation-segment')).toHaveCount(2);
  await page.getByRole('button',{name:'Закрепить как А',exact:true}).click(); await page.getByRole('button',{name:'Создать вариант Б',exact:true}).click();
  await page.route('**/api/v1/simulations',route=>route.fulfill({json:b})); await page.getByRole('button',{name:'Рассчитать Б',exact:true}).click(); await expect(page.getByRole('button',{name:'Показать А',exact:true})).toBeVisible();
  await exportPanel(page); const first = await exportFile(page,'Скачать C(t) CSV'); const rows = await parseCsv(first);
  expect(rows.filter(row=>row.record_type==='data')).toHaveLength(4094);
  expect(JSON.parse(rows.find(row=>row.record_type==='metadata')!.metadata_json).scenarios[0].reach_name).toBe(metadataName);
  expect(JSON.parse(rows.find(row=>row.record_type==='metadata')!.metadata_json).scenarios[0].geometry_source).toMatchObject(primary.reach_metadata);
  expect(Math.max(...rows.filter(row=>row.record_type==='data').map(row=>Number(row.concentration_B_mg_l)))).toBe(10.505969);
  await page.getByRole('button',{name:'Показать А',exact:true}).click();
  const second = await exportFile(page,'Скачать C(t) CSV'); expect(readFileSync((await first.path())!,'utf8')).toBe(readFileSync((await second.path())!,'utf8'));
  for(const row of rows.filter(row=>row.record_type==='data')) expect(Number(row.delta_B_minus_A_mg_l)).toBe(Number(row.concentration_B_mg_l)-Number(row.concentration_A_mg_l));
});
