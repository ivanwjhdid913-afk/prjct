import { expect, test, type Page, type Download } from "@playwright/test";
import { valuesAtHour } from "../src/scenarioComparison";
const api = process.env.SCENARIO_TEST_API;
test.use({
  baseURL:
    process.env.CONTROL_WORKSPACE_URL ??
    process.env.UI_TEST_URL ??
    "http://127.0.0.1:5173",
  video: "on",
});
test.skip(
  !api || !/^water_test_[0-9a-f]{32}$/.test(process.env.SCENARIO_TEST_DB ?? ""),
  "Requires disposable API/database.",
);

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function parameters(page: Page) {
  const toggle = page.getByRole("button", {name:"Параметры",exact:true,includeHidden:true});
  await toggle.waitFor({ state: "attached" });
  if (
    (await toggle.isVisible()) &&
    (await toggle.getAttribute("aria-expanded")) !== "true"
  )
    await toggle.click();
}
async function library(page: Page) {
  await parameters(page);
  const details = page.locator(".saved-scenarios");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
}
async function analysis(page: Page) {
  await page
    .locator(".multiple-stage-top")
    .getByRole("button", { name: "Контрольные точки", exact: true })
    .click();
  await expect(page.locator(".control-points-panel")).toBeVisible();
}
async function bytes(download: Download) {
  const chunks: Buffer[] = [];
  for await (const part of await download.createReadStream())
    chunks.push(Buffer.from(part));
  return Buffer.concat(chunks).toString("utf8");
}
async function run(page: Page) {
  await parameters(page);
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/simulations"),
  );
  await button(page, "Рассчитать").click();
  const completed = await response;
  expect(completed.status()).toBe(200);
  const result = await completed.json();
  await expect(page.locator(".simulation-segment")).toHaveCount(100);
  return result;
}

for (const width of [1280, 375])
  test(`control-point actual API lifecycle, comparison and transfer at ${width}`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: width === 375 ? 667 : 800 });
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: api + url.pathname + url.search,
      });
      await route.fulfill({ response });
    });
    let calculations = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/simulations")) calculations++;
    });
    await page.goto("/#model");
    await expect(page.locator(".simulation-preview-segment")).toHaveCount(100);
    await analysis(page);
    await page
      .getByLabel("Сегмент для контрольной точки", { exact: true })
      .selectOption("35");
    await button(page, "Закрепить выбранный сегмент").click();
    await page
      .getByLabel("Пользовательский порог, мг/л", { exact: true })
      .fill("10.2");
    await button(page, "Применить настройки анализа").click();
    expect(calculations).toBe(0);
    const demoResponse = page.waitForResponse((response) =>
      response.url().endsWith("/simulations"),
    );
    await button(page, "Демонстрация двух источников").click();
    const demo = await (await demoResponse).json();
    expect(
      demo.inputs.sources.map((source: any) => [
        source.source_distance_m,
        source.effluent_flow_m3_s,
      ]),
    ).toEqual([
      [0, 0.1],
      [1200, 0.05],
    ]);
    await expect(page.locator(".simulation-segment")).toHaveCount(100);
    await analysis(page);
    await expect(page.locator(".multiple-map-control-point")).toHaveCount(3);
    await button(page, "К максимуму Расчёт — Выше второго источника").click();
    const peakHour =
      demo.times_hours[
        demo.concentrations_mg_l
          .map((row: number[]) => row[35])
          .indexOf(
            Math.max(
              ...demo.concentrations_mg_l.map((row: number[]) => row[35]),
            ),
          )
      ];
    // Chromium serializes range values to 15 significant digits; 1e-12 h is <4 ns.
    expect(
      Number(
        await page
          .getByLabel("Время от начала сценария", { exact: true })
          .inputValue(),
      ),
    ).toBeCloseTo(peakHour, 12);
    await analysis(page);
    const pointButton = page.getByRole("button", {
      name: "Выбрать контрольную точку К1: Выше второго источника",
      exact: true,
    });
    await pointButton.click();
    await expect(page.getByTestId("temporal-threshold")).toHaveAttribute(
      "data-threshold",
      "10.2",
    );
    await expect(page.getByTestId("temporal-current")).toHaveText(
      `${valuesAtHour(demo, peakHour)[35].toLocaleString("ru-RU", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} мг/л`,
    );
    await page
      .getByLabel("Время от начала сценария", { exact: true })
      .fill("0.8");
    await page
      .getByLabel("Скорость воспроизведения", { exact: true })
      .selectOption("4");
    await button(page, "Воспроизвести").click();
    await expect
      .poll(async () =>
        Number(
          await page
            .getByLabel("Время от начала сценария", { exact: true })
            .inputValue(),
        ),
      )
      .toBeGreaterThan(1.6);
    await button(page, "Пауза").click();
    await analysis(page);
    await button(page, "К началу периода 1 Расчёт").click();
    await parameters(page);
    await button(page, "Закрепить как А").click();
    await button(page, "Создать вариант Б").click();
    await page.getByLabel("Выбрать источник 2", { exact: true }).click();
    const editor = page.locator(".load-profile-editor");
    if ((await editor.getAttribute("open")) === null)
      await editor.locator("summary").click();
    await page
      .getByLabel("Концентрация периода 1, мг/л", { exact: true })
      .fill("30");
    const b = await run(page);
    expect(demo.inputs.sources[1].load_intervals[0].effluent_mg_l).toBe(60);
    expect(b.inputs.sources[1].load_intervals[0].effluent_mg_l).toBe(30);
    await analysis(page);
    await page
      .getByLabel("Время от начала сценария", { exact: true })
      .fill("3.5");
    await expect(page.locator('[data-scenario="delta"]')).toHaveCount(3);
    const table = await page
      .locator(".control-point-results tbody")
      .innerText();
    await button(page, "Показать А").click();
    expect(await page.locator(".control-point-results tbody").innerText()).toBe(
      table,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.locator(".control-point-results").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`control-points-${width}.png`),
      fullPage: true,
    });
    const csvDownload = page.waitForEvent("download");
    await button(page, "Скачать итоги контрольных точек CSV").click();
    const csv = await bytes(await csvDownload);
    expect(csv).toContain("C(t) > threshold_mg_l");
    expect(csv).toContain("demo-control-3");
    expect(csv).toContain("conservative-1d-lateral-inflow-v2");
    await library(page);
    const name = `Контрольные точки ${width} ${Date.now()}`;
    await page.getByLabel("Название сохраняемых условий").fill(name);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/scenarios") &&
        response.request().method() === "POST",
    );
    await button(page, "Сохранить как новый сценарий").click();
    const savedResponse = await saved;
    expect(savedResponse.status()).toBe(201);
    const snapshot = await savedResponse.json();
    expect(snapshot.format_version).toBe(4);
    expect(
      snapshot.analysis_settings.points.map(
        (point: any) => point.segment_index,
      ),
    ).toEqual([35, 49, 99]);
    expect(snapshot.analysis_settings.threshold_mg_l).toBe(10.2);
    const jsonDownload = page.waitForEvent("download");
    await button(page, "Выгрузить текущие условия JSON").click();
    const document = JSON.parse(await bytes(await jsonDownload));
    expect(document.analysis_settings).toEqual(snapshot.analysis_settings);
    await page.reload();
    await library(page);
    const beforeOpen = calculations;
    await button(page, `Открыть «${name}»`).click();
    await expect(
      page.getByLabel("Название источника", { exact: true }),
    ).toHaveValue(b.inputs.sources[0].name);
    expect(calculations).toBe(beforeOpen);
    await expect(page.locator(".simulation-segment")).toHaveCount(0);
    const reopened = await run(page);
    expect(reopened.inputs).toEqual(b.inputs);
    await analysis(page);
    await expect(
      page.getByLabel("Пользовательский порог, мг/л", { exact: true }),
    ).toHaveValue("10.2");
    await expect(page.locator(".control-point-results tbody tr")).toHaveCount(
      3,
    );
    await library(page);
    await page.getByLabel("Импортировать условия JSON").setInputFiles({
      name: "analysis.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(document)),
    });
    await expect(page.getByTestId("conditions-preview")).toContainText(
      "Контрольные точки",
    );
    const beforeApply = calculations;
    await button(page, "Применить к форме").click();
    expect(calculations).toBe(beforeApply);
    await parameters(page);
    if (width === 375) await button(page, "Закрыть параметры").click();
    await analysis(page);
    await expect(page.locator(".control-point-drafts li")).toHaveCount(3);
  });
