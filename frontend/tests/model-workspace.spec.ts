import { expect, test } from '@playwright/test';

test('model selection is explicit and preserves the legacy entry point', async ({page}) => {
  await page.goto('/#model/legacy');
  const legacy=page.getByRole('button',{name:'Один источник · прежняя модель',exact:true});
  const multiple=page.getByRole('button',{name:'Несколько источников',exact:true});
  await expect(legacy).toHaveAttribute('aria-pressed','true');
  await multiple.click();
  await expect(multiple).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('heading',{name:'Несколько сценарных источников',exact:true})).toBeVisible();
  await legacy.click();
  await expect(legacy).toHaveAttribute('aria-pressed','true');
  await expect(page.getByLabel('Режим нагрузки',{exact:true})).toHaveCount(1);
});


test('new scenarios open the multi-source workspace by default', async ({page}) => {
  await page.goto('/#model');
  await expect(page.getByRole('button',{name:'Несколько источников',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('heading',{name:'Несколько сценарных источников',exact:true})).toBeVisible();
});
