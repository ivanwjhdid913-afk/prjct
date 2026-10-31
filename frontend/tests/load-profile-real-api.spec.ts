import { expect, test } from '@playwright/test';
import { openParameters, openProfile } from './model-helpers';
const api=process.env.SCENARIO_TEST_API;
test.skip(!api || !/^water_test_[0-9a-f]{32}$/.test(process.env.SCENARIO_TEST_DB??''),'Requires isolated temporary API/database.');
async function library(page:any){await openParameters(page);const d=page.locator('.saved-scenarios');if(await d.getAttribute('open')===null)await d.locator('summary').click();}
async function bytes(download:any){const stream=await download.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
for(const width of [1280,375])test(`real profile lifecycle, reload, preview and full exports at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===375?667:720});
 await page.route('https://tile.openstreetmap.org/**',r=>r.abort());
 await page.route('**/api/v1/**',async route=>{const u=new URL(route.request().url());const response=await route.fetch({url:api+u.pathname+u.search});await route.fulfill({response});});
 await page.goto('/#model');await openParameters(page);
 await page.getByLabel('Режим нагрузки',{exact:true}).selectOption('profile');await page.getByLabel('Длительность, ч').fill('6');
 const rows=[{start_hours:0,end_hours:.5,effluent_mg_l:100},{start_hours:2,end_hours:2.5,effluent_mg_l:60}];
 for(let i=0;i<rows.length;i++){await page.getByRole('button',{name:'Добавить период',exact:true}).click();for(const [label,key] of [['Начало','start_hours'],['Конец','end_hours'],['Концентрация','effluent_mg_l']] as const)await page.getByLabel(`${label} периода ${i+1}, ${key==='effluent_mg_l'?'мг/л':'ч'}`,{exact:true}).fill(String(rows[i][key]));}
 let pending=page.waitForResponse(r=>r.url().endsWith('/simulations'));await page.locator('.simulation-actions button[type=submit]').click();const firstResponse=await pending;expect(firstResponse.ok()).toBeTruthy();const first=await firstResponse.json();
 await expect(page.locator('.simulation-segment')).toHaveCount(100);
 await page.getByLabel('Время от начала сценария').fill('2.25');await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();await expect(page.getByRole('button',{name:'Пауза',exact:true})).toBeVisible();await page.getByRole('button',{name:'Пауза',exact:true}).click();
 await library(page);const name=`Два периода ${width} ${Date.now()}`;await page.getByLabel('Название сохраняемых условий').fill(name);
 let savedReply=page.waitForResponse(r=>r.url().endsWith('/scenarios')&&r.request().method()==='POST');await page.getByRole('button',{name:'Сохранить как новый сценарий',exact:true}).click();expect((await savedReply).status()).toBe(201);
 await page.reload();await library(page);await page.getByRole('button',{name:`Открыть «${name}»`,exact:true}).click();
 await expect(page.getByLabel('Режим нагрузки',{exact:true})).toHaveValue('profile');await page.locator('.load-profile-editor summary').click();
 await expect(page.getByLabel('Концентрация периода 2, мг/л',{exact:true})).toHaveValue('60');
 pending=page.waitForResponse(r=>r.url().endsWith('/simulations'));await page.locator('.simulation-actions button[type=submit]').click();const repeatResponse=await pending;expect(repeatResponse.ok()).toBeTruthy();const repeat=await repeatResponse.json();expect(repeat.concentrations_mg_l).toEqual(first.concentrations_mg_l);expect(repeat.inputs.load_intervals).toEqual(rows);
 await library(page);let download=page.waitForEvent('download');await page.getByRole('button',{name:'Выгрузить текущие условия JSON',exact:true}).click();const jsonBytes=await bytes(await download);const doc=JSON.parse(jsonBytes.toString('utf8'));expect(doc.format_version).toBe(2);expect(doc.conditions.load_intervals).toEqual(rows);
 await page.getByLabel('Импортировать условия JSON').setInputFiles({name:'два-периода.json',mimeType:'application/json',buffer:jsonBytes});await expect(page.getByTestId('conditions-preview')).toContainText('60');await page.getByRole('button',{name:'Применить к форме',exact:true}).click();
 if(width===375)await page.getByRole('button',{name:'Закрыть параметры',exact:true}).click();
 await page.getByLabel('Время от начала сценария').fill('2.25');await openProfile(page);await page.locator('.result-exports summary').click();
 download=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать C(t) CSV',exact:true}).click();const csv=(await bytes(await download)).toString('utf8');expect(csv).toContain('load_intervals');expect(csv).toContain('source_events');expect(csv).toContain('2.5');expect(csv).toContain('60');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
