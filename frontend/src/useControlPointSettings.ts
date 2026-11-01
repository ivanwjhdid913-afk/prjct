import { useState } from "react";
import {
  emptyAnalysisSettings,
  validAnalysisSettings,
  type AnalysisSettings,
  type ControlPoint,
} from "./analysisSettings";
import {
  hasSettings,
  parseThreshold,
  settingsForGeometry,
} from "./controlPointSettings";

/** Analysis drafts have their own apply boundary, independent of solver requests. */
export function useControlPointSettings(
  mapScope: string | null,
  onInteraction: () => void,
) {
  const [applied, setApplied] = useState<AnalysisSettings>(
    emptyAnalysisSettings,
  );
  const [appliedScope, setAppliedScope] = useState<string | null>(null);
  const [draftPoints, setDraftPoints] = useState<ControlPoint[]>([]);
  const [thresholdDraft, setThresholdDraft] = useState("");
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const incompatible = !!draftScope && draftScope !== mapScope;
  let draft: AnalysisSettings | null = null;
  let error: string | null = null;
  try {
    if (
      draftPoints.some((point) =>
        /[\u0000-\u001f\u007f-\u009f]/.test(point.name),
      )
    )
      throw new Error("Названия не должны содержать управляющие знаки.");
    draft = {
      points: draftPoints.map((point) => ({
        ...point,
        name: point.name.trim(),
      })),
      threshold_mg_l: parseThreshold(thresholdDraft),
    };
    if (!validAnalysisSettings(draft))
      throw new Error(
        "Названия точек: 1–80 символов без управляющих знаков; сегменты должны различаться.",
      );
    if (incompatible)
      throw new Error(
        "Настройки относятся к другой геометрии. Вернитесь к прежнему участку или сбросьте настройки для нового.",
      );
  } catch (reason) {
    error =
      reason instanceof Error ? reason.message : "Проверьте настройки анализа.";
  }
  const dirty =
    error !== null ||
    JSON.stringify(draft) !== JSON.stringify(applied) ||
    (hasSettings(applied) && appliedScope !== mapScope);

  function restore(settings: AnalysisSettings, scope: string | null) {
    const copy = structuredClone(settings);
    setApplied(copy);
    setAppliedScope(scope);
    setDraftPoints(structuredClone(copy.points));
    setThresholdDraft(
      copy.threshold_mg_l === null ? "" : String(copy.threshold_mg_l),
    );
    setDraftScope(scope);
    setSelectedId(copy.points[0]?.id ?? null);
    setNotice("");
  }
  function add(segment: number) {
    if (!mapScope || incompatible) {
      setNotice(
        "Сначала выберите совместимую геометрию или сбросьте прежние настройки.",
      );
      return;
    }
    const existing = draftPoints.find(
      (point) => point.segment_index === segment,
    );
    if (existing) {
      setSelectedId(existing.id);
      setNotice("Этот сегмент уже закреплён; выбрана существующая точка.");
      return;
    }
    if (draftPoints.length >= 5) {
      setNotice(
        "Допустимо до пяти контрольных точек. Удалите одну для добавления новой.",
      );
      return;
    }
    const point = {
      id: `checkpoint-${crypto.randomUUID()}`,
      name: `Контрольная точка ${draftPoints.length + 1}`,
      segment_index: segment,
    };
    setDraftScope(mapScope);
    setDraftPoints([...draftPoints, point]);
    setSelectedId(point.id);
    setNotice(
      "Точка добавлена в настройки. Примените анализ; новый физический расчёт не нужен.",
    );
  }
  function apply() {
    if (!draft || error || !mapScope) return;
    onInteraction();
    setApplied(structuredClone(draft));
    setAppliedScope(mapScope);
    setDraftPoints(structuredClone(draft.points));
    setDraftScope(mapScope);
    setNotice("Настройки анализа применены. Физический результат не изменён.");
  }
  return {
    applied,
    appliedScope,
    draftPoints,
    thresholdDraft,
    selectedId,
    setSelectedId,
    draftKey: JSON.stringify([draftScope, draftPoints, thresholdDraft]),
    dirty,
    error,
    notice,
    incompatible,
    restore,
    add,
    apply,
    rename: (id: string, name: string) =>
      setDraftPoints((points) =>
        points.map((point) => (point.id === id ? { ...point, name } : point)),
      ),
    remove: (id: string) => {
      setDraftPoints((points) => points.filter((point) => point.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    editThreshold: (value: string) => {
      if (!draftScope) setDraftScope(mapScope);
      setThresholdDraft(value);
    },
    reset: () => {
      onInteraction();
      restore(emptyAnalysisSettings(), mapScope);
      setNotice("Настройки явно сброшены для выбранной геометрии.");
    },
    forSave: (scope: string | null) =>
      settingsForGeometry(applied, appliedScope, scope),
    availableFor: (scope: string | null) =>
      !hasSettings(applied) || (!!scope && scope === appliedScope),
  };
}
