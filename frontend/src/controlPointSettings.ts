import {
  emptyAnalysisSettings,
  type AnalysisSettings,
} from "./analysisSettings";
import type { Reach } from "./multipleSources";

export function parseThreshold(draft: string): number | null {
  const text = draft.trim();
  if (!text) return null;
  if (
    !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ||
    !Number.isFinite(Number(text)) ||
    Number(text) < 0
  ) {
    throw new Error(
      "Пользовательский порог: введите неотрицательное число или оставьте поле пустым.",
    );
  }
  return Number(text);
}
export function hasSettings(settings: AnalysisSettings): boolean {
  return settings.points.length > 0 || settings.threshold_mg_l !== null;
}
export function geometryScope(reach: Reach | null): string | null {
  return reach
    ? JSON.stringify([
        reach.id,
        reach.metadata.geometry_sha256,
        reach.metadata.downstream_geometry_sha256,
        reach.length_m,
        100,
      ])
    : null;
}
export function settingsForGeometry(
  settings: AnalysisSettings,
  scope: string | null,
  target: string | null,
): AnalysisSettings {
  if (!hasSettings(settings)) return emptyAnalysisSettings();
  if (!scope || scope !== target) {
    throw new Error(
      "Настройки анализа относятся к другой геометрии. Вернитесь к прежнему участку или явно сбросьте контрольные точки.",
    );
  }
  return structuredClone(settings);
}
