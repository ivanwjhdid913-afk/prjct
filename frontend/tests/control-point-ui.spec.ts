import { expect, test, type Page } from "@playwright/test";
test.use({
  baseURL:
    process.env.CONTROL_PANEL_URL ??
    process.env.UI_TEST_URL ??
    "http://127.0.0.1:5173",
});

async function harness(page: Page, mode: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(`Harness error: ${error.message}`);
  });
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.route("**/__control-points?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><output aria-label="Перемотка"></output><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/tests/control-point-harness.tsx");</script>',
    }),
  );
  await page.goto(`/__control-points?mode=${mode}`);
  await expect(page.locator("#root")).toHaveAttribute("data-mounted", "true");
  expect(errors).toEqual([]);
}

test("temporal chart aligns threshold and both sets of exceedance bands in physical hours", async ({
  page,
}) => {
  await harness(page, "chart");
  await expect(page.getByTestId("temporal-threshold")).toHaveAttribute(
    "data-threshold",
    "11",
  );
  const primary = page.locator('[data-testid="temporal-exceedance-primary"]');
  const comparison = page.locator(
    '[data-testid="temporal-exceedance-comparison"]',
  );
  await expect(primary).toHaveCount(2);
  await expect(comparison).toHaveCount(2);
  await expect(primary.first()).toHaveAttribute("x", "149.5");
  await expect(primary.first()).toHaveAttribute("width", "129");
  await expect(page.getByTestId("temporal-current")).toHaveText("11,5000 мг/л");
  await expect(page.getByTestId("temporal-cursor")).toHaveAttribute(
    "data-hour",
    "1.25",
  );
});

test("any accepted finite threshold keeps every chart coordinate finite", async ({
  page,
}) => {
  await harness(page, "chart-huge");
  const threshold = page.getByTestId("temporal-threshold");
  await expect(threshold).toHaveAttribute("data-threshold", "1e+308");
  for (const attribute of ["y1", "y2"]) {
    expect(
      Number.isFinite(Number(await threshold.getAttribute(attribute))),
    ).toBeTruthy();
  }
});

test("preview has 100 selectable curved segments and K point selection is independent of sources", async ({
  page,
}) => {
  await harness(page, "map");
  await expect(page.locator(".simulation-preview-segment")).toHaveCount(100);
  await expect(page.locator(".simulation-segment")).toHaveCount(0);
  const curved = await page
    .locator(".simulation-preview-segment")
    .nth(33)
    .getAttribute("d");
  expect(curved!.match(/[ML]/g)!.length).toBeGreaterThanOrEqual(3);
  await page
    .getByTitle("Контрольная точка К1: У створа", { exact: true })
    .click();
  await expect(page.getByTestId("map-selection")).toHaveText("35 / cp-1 / 0");
  await expect(page.locator(".multiple-map-control-point")).toHaveClass(
    /is-selected/,
  );
});

test("panel shows A/B metrics, missing crossing differences and event seeks without horizontal phone overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await harness(page, "panel");
  await expect(
    page.getByRole("heading", { name: "Контрольные точки", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Итоги контрольных точек", exact: true }),
  ).toBeVisible();
  const delta = page.locator('[data-scenario="delta"]');
  await expect(delta.locator('[data-metric="crossing"]')).toHaveText("—");
  await expect(page.getByText("Нет превышения", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "К максимуму А — У створа", exact: true })
    .click();
  await expect(page.getByLabel("Перемотка")).toHaveText("1");
  await page
    .getByRole("button", { name: "К началу периода 2 А", exact: true })
    .click();
  await expect(page.getByLabel("Перемотка")).toHaveText("3.5");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("a segment can be selected by keyboard before a physical result exists", async ({
  page,
}) => {
  await harness(page, "panel-before");
  await page
    .getByLabel("Сегмент для контрольной точки", { exact: true })
    .selectOption("49");
  await expect(page.getByLabel("Перемотка")).toHaveText("49");
  await expect(
    page.getByText("Точки можно задать до расчёта.", { exact: false }),
  ).toBeVisible();
});

test("seeking another point maximum first selects its map segment and temporal profile", async ({
  page,
}) => {
  await harness(page, "panel-event-select");
  await expect(page.getByLabel("Выбранная точка и время")).toHaveText(
    "cp-2 / 0",
  );
  await page
    .getByRole("button", { name: "К максимуму Расчёт — У створа", exact: true })
    .click();
  await expect(page.getByLabel("Выбранная точка и время")).toHaveText(
    "cp-1 / 1",
  );
});

test("empty threshold remains distinct from zero, with initial and horizon exceedance reported", async ({
  page,
}) => {
  await harness(page, "panel-null");
  await expect(
    page.getByText("Пороговый анализ не задан.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-scenario="Расчёт"] [data-label="Всего выше порога"]'),
  ).toHaveText("—");
  await harness(page, "panel-zero");
  await expect(
    page.getByText("Продолжается к концу расчёта", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Уже выше порога в начале расчёта", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-scenario="Расчёт"] [data-metric="crossing"]'),
  ).toContainText("—");
  await expect(
    page.locator('[data-scenario="Расчёт"] [data-label="Всего выше порога"]'),
  ).toHaveText("5 ч");
});

test("every selected-point period remains reachable across pages", async ({
  page,
}) => {
  await harness(page, "panel-many");
  const pagination = page.getByRole("navigation", {
    name: "Страницы периодов Расчёт",
    exact: true,
  });
  await expect(pagination).toContainText("1 / 3");
  await page
    .getByRole("button", { name: "К началу периода 20 Расчёт", exact: true })
    .click();
  expect(Number(await page.getByLabel("Перемотка").textContent())).toBeCloseTo(
    1.925,
    12,
  );
  await pagination.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "К началу периода 40 Расчёт",
      exact: true,
    }),
  ).toBeVisible();
  await pagination.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(pagination).toContainText("3 / 3");
  await expect(
    page.getByRole("button", {
      name: "К началу периода 50 Расчёт",
      exact: true,
    }),
  ).toBeVisible();
});
