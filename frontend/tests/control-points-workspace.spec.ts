import { expect, test, type Page } from "@playwright/test";
import { multipleResultFixture } from "./multiple-result-fixture";
test.use({
  baseURL:
    process.env.CONTROL_WORKSPACE_URL ??
    process.env.UI_TEST_URL ??
    "http://127.0.0.1:5173",
});

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const analysis = (page: Page) => page.locator(".control-points-panel");
async function openAnalysis(page: Page) {
  await page
    .locator(".multiple-stage-top")
    .getByRole("button", { name: "Контрольные точки", exact: true })
    .click();
  await expect(analysis(page)).toBeVisible();
}
async function setup(page: Page) {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  const reaches = (
    await (await page.request.get("/api/v1/river-reaches")).json()
  ).items;
  let calls = 0;
  await page.route("**/api/v1/simulations", (route) => {
    calls++;
    const input = route.request().postDataJSON();
    return route.fulfill({
      json: multipleResultFixture(
        input,
        reaches.find((reach: any) => reach.id === input.reach_id),
      ),
    });
  });
  await page.goto("/#model");
  await expect(
    page.getByRole("heading", {
      name: "Несколько сценарных источников",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".simulation-preview-segment")).toHaveCount(100);
  return { calls: () => calls, reaches };
}

test("new workspace pins segment means before calculation and analysis edits never resubmit physics", async ({
  page,
}) => {
  const control = await setup(page);
  await openAnalysis(page);
  await page
    .getByLabel("Сегмент для контрольной точки", { exact: true })
    .selectOption("35");
  await expect(analysis(page)).toContainText("Выбран сегмент 36");
  await button(page, "Закрепить выбранный сегмент").click();
  await page
    .getByLabel("Название контрольной точки К1", { exact: true })
    .fill("Выше источника");
  await page
    .getByLabel("Пользовательский порог, мг/л", { exact: true })
    .fill("0");
  await button(page, "Применить настройки анализа").click();
  await expect(page.locator(".multiple-map-control-point")).toHaveCount(1);
  expect(control.calls()).toBe(0);
  await button(page, "Рассчитать").click();
  await expect(page.locator(".simulation-segment")).toHaveCount(100);
  await expect(analysis(page).getByRole("table")).toContainText("Сегмент 36");
  await expect(analysis(page)).toContainText("Уже выше порога");
  await page
    .getByLabel("Пользовательский порог, мг/л", { exact: true })
    .fill("invalid");
  await expect(button(page, "Применить настройки анализа")).toBeDisabled();
  await expect(analysis(page)).toContainText(
    "Таблица и экспорт используют применённые настройки",
  );
  const download = page.waitForEvent("download");
  await button(page, "Скачать итоги контрольных точек CSV").click();
  const csv = await download;
  expect(csv.suggestedFilename()).toBe("control-points.csv");
  expect(control.calls()).toBe(1);
  await page
    .getByLabel("Пользовательский порог, мг/л", { exact: true })
    .fill("");
  await button(page, "Применить настройки анализа").click();
  await expect(analysis(page)).toContainText("Пороговый анализ не задан");
  expect(control.calls()).toBe(1);
});

test("demo installs user segments 36/50/100 and A/B metrics share the physical clock", async ({
  page,
}) => {
  const control = await setup(page);
  await button(page, "Демонстрация двух источников").click();
  await expect(page.locator(".simulation-segment")).toHaveCount(100);
  await openAnalysis(page);
  await expect(page.locator(".control-point-drafts")).toContainText(
    "Сегмент 36",
  );
  await expect(page.locator(".control-point-drafts")).toContainText(
    "Сегмент 50",
  );
  await expect(page.locator(".control-point-drafts")).toContainText(
    "Сегмент 100",
  );
  await expect(
    page.getByLabel("Пользовательский порог, мг/л", { exact: true }),
  ).toHaveValue("10.2");
  await button(page, "К максимуму Расчёт — Выше второго источника").click();
  const time = await page
    .getByLabel("Время от начала сценария", { exact: true })
    .inputValue();
  expect(Number(time)).toBe(1.5);
  await button(page, "Закрепить как А").click();
  await button(page, "Создать вариант Б").click();
  await page
    .getByLabel("Расход стоков выбранного источника q, м³/с", { exact: true })
    .fill("0");
  await button(page, "Рассчитать").click();
  await expect(page.locator(".multiple-ab")).toBeVisible();
  await openAnalysis(page);
  await expect(page.locator('[data-scenario="delta"]')).toHaveCount(3);
  const rows = await page.locator(".control-point-results tbody").innerText();
  await button(page, "Показать А").click();
  expect(await page.locator(".control-point-results tbody").innerText()).toBe(
    rows,
  );
  expect(
    await page
      .getByLabel("Время от начала сценария", { exact: true })
      .inputValue(),
  ).toBe(time);
  expect(control.calls()).toBe(2);
});

test("changing geometry retains applied settings with an explicit mismatch and reset", async ({
  page,
}) => {
  await setup(page);
  await button(page, "Демонстрация двух источников").click();
  await expect(page.locator(".simulation-segment")).toHaveCount(100);
  await page
    .getByLabel("Подготовленный участок", { exact: true })
    .selectOption("voronezh-zheltye-peski");
  await openAnalysis(page);
  await expect(analysis(page)).toContainText("другой геометрии");
  await expect(page.locator(".multiple-map-control-point")).toHaveCount(0);
  await expect(page.locator(".control-point-drafts li")).toHaveCount(3);
  await button(page, "Сбросить точки и порог для текущего участка").click();
  await expect(page.locator(".control-point-drafts li")).toHaveCount(0);
  await expect(
    page.getByLabel("Пользовательский порог, мг/л", { exact: true }),
  ).toHaveValue("");
});

test("physical edits during a request keep completed analytics tied to their own inputs", async ({
  page,
}) => {
  const control = await setup(page);
  await button(page, "Демонстрация двух источников").click();
  await expect(page.locator(".simulation-segment")).toHaveCount(100);
  await openAnalysis(page);
  const before = await page.locator(".control-point-results tbody").innerText();
  let release: (() => void) | undefined;
  await page.route("**/api/v1/simulations", async (route) => {
    const input = route.request().postDataJSON();
    const result = multipleResultFixture(
      input,
      control.reaches.find((reach: any) => reach.id === input.reach_id),
    );
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: result });
  });
  await button(page, "Рассчитать").click();
  await expect.poll(() => !!release).toBeTruthy();
  await page
    .getByLabel("Расход стоков выбранного источника q, м³/с", { exact: true })
    .fill("0");
  expect(await page.locator(".control-point-results tbody").innerText()).toBe(
    before,
  );
  await expect(page.locator(".simulation-stale")).toBeVisible();
  release!();
  await expect(page.locator(".calculation-status")).toHaveCount(0);
  expect(await page.locator(".control-point-results tbody").innerText()).toBe(
    before,
  );
  await expect(page.locator(".simulation-stale")).toBeVisible();
});

for (const close of ["escape", "button"])
  test(`closing analysis before a calculation restores its opener: ${close}`, async ({
    page,
  }) => {
    await setup(page);
    const opener = page
      .locator(".multiple-stage-top")
      .getByRole("button", { name: "Контрольные точки", exact: true });
    await opener.click();
    await expect(button(page, "Закрыть профиль")).toBeFocused();
    if (close === "escape") await page.keyboard.press("Escape");
    else await button(page, "Закрыть профиль").click();
    await expect(opener).toBeFocused();
  });

test("the whole reach remains visible when a first result adds the phone time controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await setup(page);
  await openAnalysis(page);
  await button(page, "Демонстрация двух источников").click();
  await expect(page.locator(".simulation-segment")).toHaveCount(100);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const map = document
          .querySelector(".multiple-map")!
          .getBoundingClientRect();
        const profile = document
          .querySelector(".multiple-profile")!
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll(
            ".multiple-map-source,.multiple-map-control-point",
          ),
        ].every((element) => {
          const r = element.getBoundingClientRect();
          return (
            r.top >= map.top &&
            r.bottom <= profile.top &&
            r.left >= map.left &&
            r.right <= map.right
          );
        });
      }),
    )
    .toBeTruthy();
});
