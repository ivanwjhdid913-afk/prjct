import { expect, test, type Page } from '@playwright/test';
import { riverCoordinate } from '../src/riverCoordinate';
test.use({baseURL:process.env.MULTIPLE_UI_URL??'http://127.0.0.1:5173'});
import { buildMultipleConditions, newSourceDraft, multipleComparisonReason, validMultipleResult } from '../src/multipleSources';

test('multiple source drafts preserve separate immutable schedules and reject invalid coordinates', () => {
  const a=newSourceDraft(1),b=newSourceDraft(2);b.source_distance_m='1200';b.load_mode='profile';b.rows=[{id:'r',start_hours:'2',end_hours:'2.5',effluent_mg_l:'60'}];
  const shared={river_flow_m3_s:'10',background_mg_l:'10',velocity_m_s:'.25',dispersion_m2_s:'5',duration_hours:'6'};
  const result=buildMultipleConditions(shared,'don-olkhovets',3126,[a,b]);
  expect(result.sources[1].source_distance_m).toBe(1200);expect(result.sources[1].load_intervals).toEqual([{start_hours:2,end_hours:2.5,effluent_mg_l:60}]);
  b.rows[0].effluent_mg_l='30';expect(result.sources[1].load_intervals![0].effluent_mg_l).toBe(60);
  b.source_distance_m='3027';expect(()=>buildMultipleConditions(shared,'don-olkhovets',3126,[a,b])).toThrow('100');
});
test('three source limit, duplicate ids, empty numeric values and profiles fail without coercion',()=>{
  const shared={river_flow_m3_s:'10',background_mg_l:'10',velocity_m_s:'.25',dispersion_m2_s:'5',duration_hours:'6'};
  expect(()=>buildMultipleConditions(shared,'r',3126,[])).toThrow();
  expect(()=>buildMultipleConditions(shared,'r',3126,[1,2,3,4].map(newSourceDraft))).toThrow();
  const a=newSourceDraft(1);expect(()=>buildMultipleConditions({...shared,background_mg_l:''},'r',3126,[a])).toThrow();
  expect(()=>buildMultipleConditions(shared,'r',3126,[a,a])).toThrow();
  a.load_mode='profile';a.rows=[{id:'r',start_hours:'0',end_hours:'',effluent_mg_l:'100'}];expect(()=>buildMultipleConditions(shared,'r',3126,[a])).toThrow();
});

test('new workspace allows three stable source records, selects and deletes only the chosen record',async({page})=>{
  await page.goto('/#model');await page.getByRole('button',{name:'Несколько источников',exact:true}).click();
  const params=page.getByRole('button',{name:'Параметры',exact:true});if(await params.isVisible())await params.click();
  await page.getByRole('button',{name:'Добавить источник',exact:true}).click();await page.getByLabel('Название источника',{exact:true}).fill('Второй');
  await page.getByRole('button',{name:'Добавить источник',exact:true}).click();await expect(page.getByRole('button',{name:'Добавить источник',exact:true})).toBeDisabled();
  await expect(page.locator('.multiple-source-choice')).toHaveCount(3);await page.getByLabel('Выбрать источник 2').click();await expect(page.getByLabel('Название источника',{exact:true})).toHaveValue('Второй');
  await page.getByRole('button',{name:'Удалить выбранный источник',exact:true}).click();await expect(page.locator('.multiple-source-choice')).toHaveCount(2);
});

async function prepare(page:Page){await page.route('https://tile.openstreetmap.org/**',r=>r.abort());await page.goto('/#model');await page.getByRole('button',{name:'Несколько источников',exact:true}).click();await expect(page.getByRole('heading',{name:'Несколько сценарных источников'})).toBeVisible();const params=page.getByRole('button',{name:'Параметры',exact:true});if(await params.isVisible())await params.click();}
function fixture(input:any,reach:any){const coordinates=Array.from({length:101},(_,i)=>riverCoordinate(reach.geometry.coordinates,reach.distances_m,reach.length_m*i/100));const times=[0,input.duration_hours/4,input.duration_hours/2,input.duration_hours];const amplitude=input.sources.reduce((sum:number,s:any)=>sum+s.effluent_flow_m3_s*((s.effluent_mg_l??s.load_intervals?.[0]?.effluent_mg_l??input.background_mg_l)-input.background_mg_l)/10,0);
 return {format_version:3,model_id:'conservative-1d-lateral-inflow-v2',inputs:{...input,length_m:reach.length_m},reach_id:reach.id,source_distance_m:0,source_coordinate:coordinates[0],source_coordinates:input.sources.map((s:any)=>({id:s.id,source_distance_m:s.source_distance_m,coordinate:riverCoordinate(reach.geometry.coordinates,reach.distances_m,s.source_distance_m)})),geometry:reach.geometry,reach_metadata:reach.metadata,segment_geometries:coordinates.slice(0,-1).map((point:any,i:number)=>({type:'LineString',coordinates:[point,coordinates[i+1]]})),distances_m:Array.from({length:100},(_,i)=>reach.length_m*(i+.5)/100),times_hours:times,concentrations_mg_l:times.map((_:number,t:number)=>Array.from({length:100},(_,j)=>input.background_mg_l+amplitude*(t===1?1:t===2?.5:0)*(1-j/150))),scale_mg_l:[input.background_mg_l,input.background_mg_l+Math.max(amplitude,0)],derived:{total_flow_m3_s:input.river_flow_m3_s+input.sources.reduce((n:number,s:any)=>n+s.effluent_flow_m3_s,0),area_m2:40,travel_hours:4,load_kg_s:null,excess_load_kg_s:null,steady_mg_l:null},diagnostics:{},temporal_resolution:{method:'adaptive-step-states',saved_states:4,reference_states:49,max_states:2048,interpolation_relative_tolerance:.01,interpolation_absolute_tolerance_mg_l:1e-9,max_relative_interpolation_error:.009,reference_max_step_seconds:10,max_gap_seconds:1000,memory_limit_bytes:16777216,reference_memory_bytes:50000,max_response_bytes:5242880}};}
async function mock(page:Page,hold?:(release:()=>void)=>void){const reaches=await(await page.request.get('/api/v1/river-reaches')).json();const reach=reaches.items.find((r:any)=>r.id==='don-olkhovets');await page.route('**/api/v1/simulations',async route=>{const input=route.request().postDataJSON(),body=fixture(input,reach);if(hold)await new Promise<void>(resolve=>hold(resolve));try{await route.fulfill({json:body});}catch{/* Cancellation may close the intercepted request. */}});return reach;}
async function run(page:Page){const wait=page.waitForResponse(r=>r.url().endsWith('/simulations'));await page.getByRole('button',{name:'Рассчитать',exact:true}).click();await wait;await expect(page.locator('.simulation-segment')).toHaveCount(100);}

test('pending source geometry edits remain a draft after completion and saved source states do not acquire new conditions',async({page})=>{
 await prepare(page);let release!:()=>void;await mock(page,r=>{release=r;});await page.getByRole('button',{name:'Рассчитать',exact:true}).click();await expect.poll(()=>!!release).toBeTruthy();await page.getByLabel('Положение выбранного источника, м от начала участка',{exact:true}).fill('100');release();await expect(page.locator('.simulation-stale')).toBeVisible();await expect(page.locator('.multiple-stage-top')).toContainText('черновик положений');await page.getByRole('button',{name:'Показать завершённый расчёт',exact:true}).click();await expect(page.locator('.simulation-segment')).toHaveCount(100);await expect(page.getByTestId('source-status')).toContainText('100,0000');
});

test('A/B keeps source positions independent, shared scale and time while switching without a new map',async({page})=>{
 await prepare(page);await mock(page);await run(page);await page.getByRole('button',{name:'Закрепить как А',exact:true}).click();await page.getByRole('button',{name:'Создать вариант Б',exact:true}).click();await page.getByLabel('Положение выбранного источника, м от начала участка',{exact:true}).fill('1200');await page.getByLabel('Концентрация стоков выбранного источника ce, мг/л',{exact:true}).fill('50');await run(page);await page.getByLabel('Время от начала сценария',{exact:true}).fill('1.5');const scale=await page.getByTestId('concentration-scale').innerText();await page.locator('.multiple-map .leaflet-map-pane').evaluate(e=>(e as HTMLElement).dataset.identity='same');for(const name of ['Показать А','Показать Б']){await page.getByRole('button',{name,exact:true}).click();await expect(page.getByLabel('Время от начала сценария',{exact:true})).toHaveValue('1.5');await expect(page.getByTestId('concentration-scale')).toHaveText(scale,{useInnerText:true});await expect(page.locator('.multiple-map .leaflet-map-pane')).toHaveAttribute('data-identity','same');}await page.getByRole('button',{name:'Профиль и показатели',exact:true}).click();await expect(page.getByTestId('comparison-values')).toContainText('Б − А');await expect(page.getByTestId('source-status')).toContainText('А:');await expect(page.getByTestId('source-status')).toContainText('Б:');
});

test('phone parameter focus and covered controls remain inaccessible, status stays visible with profile open',async({page})=>{
 await page.setViewportSize({width:375,height:667});await prepare(page);await expect(page.getByRole('button',{name:'Закрыть параметры'})).toBeFocused();await mock(page);await run(page);await page.getByRole('button',{name:'Профиль и показатели',exact:true}).click();await page.getByRole('button',{name:'Параметры',exact:true}).click();await page.getByLabel('Концентрация стоков выбранного источника ce, мг/л',{exact:true}).fill('50');await expect(page.locator('.multiple-time-panel')).toHaveAttribute('inert','');await expect(page.locator('.multiple-map')).toHaveAttribute('inert','');await page.getByRole('button',{name:'Закрыть параметры'}).click();await expect(page.getByRole('button',{name:'Параметры',exact:true})).toBeFocused();await expect(page.locator('.simulation-stale')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('semantically identical interval objects with different JSON key order remain valid completed results',async({page})=>{
 await prepare(page);const reaches=await(await page.request.get('/api/v1/river-reaches')).json();const reach=reaches.items.find((r:any)=>r.id==='don-olkhovets');await page.route('**/api/v1/simulations',async route=>{const input=route.request().postDataJSON();input.sources[0].load_intervals=input.sources[0].load_intervals.map((row:any)=>({effluent_mg_l:row.effluent_mg_l,end_hours:row.end_hours,start_hours:row.start_hours}));await route.fulfill({json:fixture(input,reach)});});await page.getByLabel('Режим нагрузки выбранного источника',{exact:true}).selectOption('profile');await page.getByRole('button',{name:'Добавить период',exact:true}).click();await page.getByLabel('Начало периода 1, ч',{exact:true}).fill('0');await page.getByLabel('Конец периода 1, ч',{exact:true}).fill('.5');await page.getByLabel('Концентрация периода 1, мг/л',{exact:true}).fill('100');await run(page);await expect(page.locator('.simulation-error')).toHaveCount(0);
});

test('multiple result guards reject malformed source coordinates, metadata, time arrays and negative concentrations',()=>{
 const input=buildMultipleConditions({river_flow_m3_s:'10',background_mg_l:'10',velocity_m_s:'.25',dispersion_m2_s:'5',duration_hours:'6'},'r',1000,[newSourceDraft(1)]);const reach={id:'r',name:'R',length_m:1000,geometry:{type:'LineString',coordinates:[[40,52],[40,52.1]]},distances_m:[0,1000],metadata:{}};const result=fixture(input,reach);expect(validMultipleResult(result)).toBe(true);
 for(const bad of [{...result,source_coordinates:[null]},{...result,source_coordinate:null},{...result,reach_metadata:null},{...result,times_hours:[0,2,1,6]},{...result,times_hours:[0,1,2,5.9]},{...result,concentrations_mg_l:result.concentrations_mg_l.map((r:any,i:number)=>i===1?r.map(()=>-1):r)}])expect(validMultipleResult(bad)).toBe(false);
});

test('invalid geodesic snap response does not move or silently validate selected source',async({page})=>{
 await prepare(page);await page.route('**/source-snap?*',route=>route.fulfill({json:{reach_id:'don-olkhovets',source_distance_m:100,distance_to_river_m:-1,max_distance_m:75,coordinate:[]}}));await page.getByRole('button',{name:'Выбрать положение на карте',exact:true}).click();await page.locator('.multiple-map .point-map').click({position:{x:200,y:100}});await expect(page.locator('.multiple-pick-notice')).toContainText('некорректную');await expect(page.getByLabel('Положение выбранного источника, м от начала участка',{exact:true})).toHaveValue('0');
});

test('error and cancellation keep pinned A and reject an old delayed response',async({page})=>{
 await prepare(page);const reach=await mock(page);await run(page);await page.getByRole('button',{name:'Закрепить как А',exact:true}).click();await page.getByRole('button',{name:'Создать вариант Б',exact:true}).click();await page.getByLabel('Концентрация стоков выбранного источника ce, мг/л',{exact:true}).fill('50');await page.route('**/api/v1/simulations',r=>r.fulfill({status:422,json:{detail:'Контрольный отказ расчёта'}}));await page.getByRole('button',{name:'Рассчитать',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Контрольный отказ');await expect(page.locator('.simulation-segment')).toHaveCount(100);await expect(page.getByTestId('source-status')).toContainText('100,0000');let release!:()=>void;await page.route('**/api/v1/simulations',async r=>{const body=fixture(r.request().postDataJSON(),reach);await new Promise<void>(resolve=>release=resolve);try{await r.fulfill({json:body});}catch{}});await page.getByRole('button',{name:'Рассчитать',exact:true}).click();await expect.poll(()=>!!release).toBeTruthy();await page.getByRole('button',{name:'Отменить ожидание',exact:true}).click();release();await expect(page.locator('.calculation-status')).toContainText('Ожидание отменено');await expect(page.getByTestId('source-status')).toContainText('100,0000');await expect(page.getByRole('button',{name:'Показать Б',exact:true})).toHaveCount(0);
});

test('coincident map markers remain distinct and map selection edits only that source; stale snap is ignored',async({page})=>{
 page.setDefaultTimeout(5000);
 await prepare(page);await page.getByRole('button',{name:'Добавить источник',exact:true}).click();await expect(page.locator('.multiple-map-source')).toHaveCount(2);await page.getByTitle('Сценарный источник 1: Источник 1',{exact:true}).click();await page.getByLabel('Название источника',{exact:true}).fill('Первый');await page.getByLabel('Выбрать источник 2',{exact:true}).click();await expect(page.getByLabel('Название источника',{exact:true})).toHaveValue('Источник 2');let release!:()=>void;await page.route('**/source-snap?*',async r=>{await new Promise<void>(resolve=>release=resolve);try{await r.fulfill({json:{reach_id:'don-olkhovets',source_distance_m:100,distance_to_river_m:0,max_distance_m:75,coordinate:[38.9,52.4]}});}catch{}});await page.getByRole('button',{name:'Выбрать положение на карте',exact:true}).click();await page.locator('.multiple-map .point-map').click({position:{x:200,y:100}});await expect.poll(()=>!!release).toBeTruthy();await page.getByLabel('Выбрать источник 1',{exact:true}).click();release();await expect(page.getByLabel('Название источника',{exact:true})).toHaveValue('Первый');await expect(page.getByLabel('Положение выбранного источника, м от начала участка',{exact:true})).toHaveValue('0');await page.getByLabel('Выбрать источник 2',{exact:true}).click();await expect(page.getByLabel('Положение выбранного источника, м от начала участка',{exact:true})).toHaveValue('0');
});

test('physical playback time and cursor are independent of sparse saved-state indices',async({page})=>{
 await prepare(page);await mock(page);await run(page);await page.getByRole('button',{name:'Профиль и показатели',exact:true}).click();const clockStart=new Date('2026-10-31T12:00:00Z');await page.clock.install({time:clockStart});await page.clock.pauseAt(clockStart);await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();await page.clock.runFor(1000);const time=Number(await page.getByLabel('Время от начала сценария',{exact:true}).inputValue());expect(Math.abs(time-.25)).toBeLessThan(.006);const synchronized=await page.evaluate(()=>({input:document.querySelector<HTMLInputElement>('#multiple-clock')!.value,cursor:document.querySelector('[data-testid=temporal-cursor]')!.getAttribute('data-hour')}));expect(Math.abs(Number(synchronized.input)-Number(synchronized.cursor))).toBeLessThanOrEqual(8*Number.EPSILON*Math.max(1,Math.abs(Number(synchronized.cursor))));await page.getByRole('button',{name:'Пауза',exact:true}).click();const paused=await page.getByLabel('Время от начала сценария',{exact:true}).inputValue();await page.clock.runFor(1000);await expect(page.getByLabel('Время от начала сценария',{exact:true})).toHaveValue(paused);
});


test('short phone keeps at least 100px of map exposed with the temporal profile open',async({page})=>{
 await page.setViewportSize({width:375,height:667});await prepare(page);await mock(page);await run(page);
 await page.getByRole('button',{name:'Профиль и показатели',exact:true}).click();
 const exposed=await page.evaluate(()=>document.querySelector('.multiple-profile')!.getBoundingClientRect().top-document.querySelector('.multiple-map')!.getBoundingClientRect().top);
 expect(exposed).toBeGreaterThanOrEqual(100);
 await expect(page.getByLabel('Время от начала сценария',{exact:true})).toBeInViewport();
});


test('rapid source creation and mode edits keep each source flow attached to its stable identifier',async({page})=>{
 await prepare(page);
 for(let i=0;i<8;i++){
  await page.getByRole('button',{name:'Добавить источник',exact:true}).click();
  await page.getByLabel('Расход стоков выбранного источника q, м³/с',{exact:true}).fill('.05');
  await page.getByLabel('Режим нагрузки выбранного источника',{exact:true}).selectOption('profile');
  await page.getByRole('button',{name:'Добавить период',exact:true}).click();
  await expect(page.getByLabel('Расход стоков выбранного источника q, м³/с',{exact:true})).toHaveValue('.05');
  await page.getByLabel('Выбрать источник 1',{exact:true}).click();
  await expect(page.getByLabel('Расход стоков выбранного источника q, м³/с',{exact:true})).toHaveValue('.1');
  await page.getByLabel('Выбрать источник 2',{exact:true}).click();
  await expect(page.getByLabel('Расход стоков выбранного источника q, м³/с',{exact:true})).toHaveValue('.05');
  await page.getByRole('button',{name:'Удалить выбранный источник',exact:true}).click();
 }
});
