import { expect, test, type Page } from '@playwright/test';
import { multipleResultFixture } from './multiple-result-fixture';
const storedId = '00000000-0000-4000-8000-000000000055';
const button = (page: Page, name: string) => page.getByRole('button', {name, exact:true});

async function setup(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  const reach = (await (await page.request.get('/api/v1/river-reaches')).json()).items.find((r: any) => r.id === 'don-olkhovets');
  const conditions = {river_flow_m3_s:10, background_mg_l:10, velocity_m_s:.25, dispersion_m2_s:5, duration_hours:6, reach_id:reach.id,
    sources:[{id:'saved-c', name:'Условия C', source_distance_m:100, effluent_flow_m3_s:.2, effluent_mg_l:400, load_mode:'continuous', load_duration_hours:null, load_intervals:null}]};
  const stored = {id:storedId, name:'Условия C', created_at:'2026-11-01T00:00:00Z', geometry_mode:'river', load_mode:'multiple', format_version:3,
    model_id:'conservative-1d-lateral-inflow-v2', geometry_version:'river-wgs84-v1', geometry_sha256:reach.metadata.geometry_sha256,
    downstream_geometry_sha256:reach.metadata.downstream_geometry_sha256, reach_id:reach.id, reach_name:reach.name, geometry_source:{source:'test fixture'},
    conditions, compatibility:{compatible:true,reasons:[]}};
  await page.route('**/api/v1/scenarios?*', route => route.fulfill({json:{items:[stored],total:1,limit:20,offset:0}}));
  let releaseOpen: (()=>void) | undefined;
  let releaseCalculation: (()=>void) | undefined;
  await page.route(`**/api/v1/scenarios/${storedId}`, async route => {
    await new Promise<void>(resolve => {releaseOpen=resolve;});
    try {await route.fulfill({json:stored});} catch { /* cancelled browser request */ }
  });
  await page.route('**/api/v1/simulations', async route => {
    const result=multipleResultFixture(route.request().postDataJSON(),reach);
    await new Promise<void>(resolve => {releaseCalculation=resolve;});
    try {await route.fulfill({json:result});} catch { /* cancelled browser request */ }
  });
  await page.goto('/#model');
  await button(page,'Несколько источников').click();
  await expect(page.getByRole('heading',{name:'Несколько сценарных источников',exact:true})).toBeVisible();
  await page.locator('.saved-scenarios summary').click();
  await expect(button(page,'Открыть «Условия C»')).toBeVisible();
  return {
    stored,
    async beginOpen() {releaseOpen=undefined;await button(page,'Открыть «Условия C»').click();await expect.poll(()=>!!releaseOpen).toBeTruthy();},
    async beginCalculation() {releaseCalculation=undefined;await button(page,'Рассчитать').click();await expect.poll(()=>!!releaseCalculation).toBeTruthy();},
    finishOpen() {releaseOpen!();},
    finishCalculation() {releaseCalculation!();},
  };
}
const unchanged = (page: Page) => expect(page.getByLabel('Концентрация стоков выбранного источника ce, мг/л',{exact:true})).toHaveValue('100');

test('an older saved open cannot cancel a newer calculation with identical draft values', async ({page}) => {
  const control=await setup(page);
  await control.beginOpen();
  await control.beginCalculation();
  control.finishOpen();
  await expect(page.locator('.saved-scenarios')).toContainText('более новое действие');
  await unchanged(page);
  await expect(page.locator('.calculation-status')).toContainText('Выполняется расчёт');
  control.finishCalculation();
  await expect(page.locator('.simulation-segment')).toHaveCount(100);
  await unchanged(page);
  // A new explicit open remains available after the rejected old action.
  await control.beginOpen();control.finishOpen();
  await expect(page.getByLabel('Название источника',{exact:true})).toHaveValue('Условия C');
});

test('an older saved open cannot apply after cancellation of a calculation', async ({page}) => {
  const control=await setup(page);
  await control.beginCalculation();await control.beginOpen();
  await button(page,'Отменить ожидание').click();control.finishOpen();
  await expect(page.locator('.saved-scenarios')).toContainText('более новое действие');
  await unchanged(page);control.finishCalculation();
});

test('a prepared JSON preview becomes stale after a new calculation and can be explicitly prepared again', async ({page}) => {
  const control=await setup(page);
  const {id,created_at,load_mode,compatibility,...document}=control.stored;
  await page.route('**/api/v1/scenario-files/validate', route=>route.fulfill({json:{document,compatibility}}));
  const upload=()=>page.getByLabel('Импортировать условия JSON').setInputFiles({name:'условия.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});
  await upload();await expect(page.getByTestId('conditions-preview')).toBeVisible();
  await control.beginCalculation();await button(page,'Применить к форме').click();
  await expect(page.locator('.conditions-transfer')).toContainText('более новое действие');await unchanged(page);
  control.finishCalculation();await expect(page.locator('.simulation-segment')).toHaveCount(100);
  await upload();await expect(page.getByTestId('conditions-preview')).toBeVisible();await button(page,'Применить к форме').click();
  await expect(page.getByLabel('Название источника',{exact:true})).toHaveValue('Условия C');
});

for (const action of ['pin','variant'] as const) test(`late open cannot undo the newer ${action} action`, async ({page})=>{
  const control=await setup(page);await control.beginCalculation();control.finishCalculation();await expect(page.locator('.simulation-segment')).toHaveCount(100);
  if(action==='variant') await button(page,'Закрепить как А').click();
  await control.beginOpen();
  await button(page,action==='pin'?'Закрепить как А':'Создать вариант Б').click();
  control.finishOpen();await expect(page.locator('.saved-scenarios')).toContainText('более новое действие');await unchanged(page);
});
